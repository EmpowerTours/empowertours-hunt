"use client";

import type { LocalAccount } from "viem";
import { publicClient, walletClientFor } from "./swap";
import { AUSD, USDC, kuruQuote, kuruToken, type KuruQuote } from "./kuru";

// ---------------------------------------------------------------------------
// Executing the Kuru on-ramp from the browser, with the hunter signing.
//
// Three transactions, and the shape is forced rather than chosen:
//
//   1. MON  -> USDC   on Kuru's ORDER BOOK          <- the trade
//   2. approve USDC   to Kuru's entrypoint          <- only if allowance short
//   3. USDC -> AUSD   stable hop                    <- the conversion
//
// Step 1 is the one that matters. Measured on mainnet, a MON->USDC quote
// carries Kuru's MON/USDC market in its calldata and does NOT carry Uniswap
// v4's pool manager; a MON->AUSD quote is the exact reverse. So the only way to
// put a hunter's trade on Kuru's book is to go through USDC — Kuru's own
// MON/AUSD book is ~$5 deep and prices 17% off market.
//
// Step 2 exists because step 3 spends an ERC-20 rather than native MON, and the
// allowance starts at zero. It is skipped when the allowance already covers the
// amount, so it is a first-swap cost, not a per-swap one.
//
// WHY THE SECOND LEG IS RE-QUOTED. The plan shown to the hunter quotes leg 2
// against leg 1's EXPECTED output. What actually arrives can be a shade less.
// Signing a leg 2 built on the estimate would revert on its own minOut and, on
// Monad, burn the whole gas limit doing it. So leg 2 is quoted again from the
// balance that really landed.
//
// Nothing here can move a hunter's funds without their passkey: every step is
// signed in the page by the wallet derived from their own credential.
// ---------------------------------------------------------------------------

const ERC20_ABI = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export type KuruStep =
  "quoting" | "trading-on-book" | "approving" | "converting" | "done";

export interface KuruSwapResult {
  /** AUSD that actually arrived, measured from the balance, not the quote. */
  ausdOut: bigint;
  /** The order-book trade. Kept so the UI can link it — it is the claim. */
  bookTxHash: `0x${string}`;
  convertTxHash: `0x${string}`;
  /** False if Kuru rerouted leg 1 away from the book between quote and send. */
  wentThroughOrderBook: boolean;
}

/**
 * Send one Kuru-provided transaction and wait for it.
 *
 * Simulated first, always. A reverted transaction on Monad is charged at the
 * full gas limit with no refund, so finding out by sending is the expensive way
 * to learn the quote went stale.
 */
async function sendQuoted(
  account: LocalAccount,
  q: KuruQuote,
): Promise<`0x${string}`> {
  const pc = publicClient();
  await pc.call({
    account: account.address,
    to: q.to,
    data: q.calldata,
    value: q.value,
  });
  const hash = await walletClientFor(account).sendTransaction({
    to: q.to,
    data: q.calldata,
    value: q.value,
  });
  const receipt = await pc.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`kuru: transaction ${hash} reverted`);
  }
  return hash;
}

/**
 * MON -> AUSD, with the trade on Kuru's order book.
 *
 * `onStep` is called before each leg so the page can say which of the three
 * signatures the hunter is being asked for. Three unexplained prompts is how a
 * working flow gets abandoned halfway, leaving someone holding USDC and no idea
 * why.
 */
export async function swapMonToAusdViaKuru(args: {
  account: LocalAccount;
  monWei: bigint;
  onStep?: (step: KuruStep) => void;
}): Promise<KuruSwapResult> {
  const { account, monWei } = args;
  const step = args.onStep ?? (() => {});
  const pc = publicClient();
  const user = account.address;

  step("quoting");
  const token = await kuruToken(user);

  // --- 1. the trade, on the book ------------------------------------------
  const leg1 = await kuruQuote({
    token,
    userAddress: user,
    tokenIn: "0x0000000000000000000000000000000000000000",
    tokenOut: USDC,
    amount: monWei,
  });
  const usdcBefore = (await pc.readContract({
    address: USDC,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [user],
  })) as bigint;

  step("trading-on-book");
  const bookTxHash = await sendQuoted(account, leg1);

  const usdcAfter = (await pc.readContract({
    address: USDC,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [user],
  })) as bigint;
  const usdcIn = usdcAfter - usdcBefore;
  if (usdcIn <= 0n) {
    throw new Error("kuru: the order-book trade delivered no USDC");
  }

  // --- 2. allowance, only if it is short ----------------------------------
  const allowance = (await pc.readContract({
    address: USDC,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [user, leg1.to],
  })) as bigint;
  if (allowance < usdcIn) {
    step("approving");
    // Exactly what this swap needs, not an unbounded approval. A hunter's
    // wallet is their whole balance here and there is no reason to leave a
    // standing claim on it to save one signature later.
    const approveHash = await walletClientFor(account).writeContract({
      address: USDC,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [leg1.to, usdcIn],
    });
    const r = await pc.waitForTransactionReceipt({ hash: approveHash });
    if (r.status !== "success") throw new Error("kuru: USDC approval reverted");
  }

  // --- 3. the conversion, quoted from what actually arrived ---------------
  step("converting");
  const leg2 = await kuruQuote({
    token,
    userAddress: user,
    tokenIn: USDC,
    tokenOut: AUSD,
    amount: usdcIn,
  });
  const ausdBefore = (await pc.readContract({
    address: AUSD,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [user],
  })) as bigint;
  const convertTxHash = await sendQuoted(account, leg2);
  const ausdAfter = (await pc.readContract({
    address: AUSD,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [user],
  })) as bigint;

  step("done");
  return {
    // Measured, not quoted. What the hunter has is what the chain says.
    ausdOut: ausdAfter - ausdBefore,
    bookTxHash,
    convertTxHash,
    wentThroughOrderBook: leg1.usesOrderBook,
  };
}
