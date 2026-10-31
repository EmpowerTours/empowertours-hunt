// ---------------------------------------------------------------------------
// Kuru's relaunched exchange (live since ~2026-10-17): MON <-> USDC on the
// order book, called directly on chain. No Kuru API sits in the money path.
//
// The old integration (kuru.ts, kuru-swap.ts) asked ws.kuru.io for a quote and
// signed the calldata it returned. That host stopped answering on 2026-10-30
// and appears nowhere in Kuru's current docs or web bundle, and the market it
// routed to (0x065c9d28…) is not in the active catalog — its book had zero
// bids. See memory: reference_kuru_v2_migration.
//
// The new shape, every call confirmed against Kuru's own SDK source
// (@toxicflow-labs/ts-sdk 0.2.0, repo Kuru-Labs/ts-sdk):
//
//   1. AccountCore.deposit(owner, tokenIn, amount)   creates the account if new
//   2. OrderBook.swap(rootId, isBuy, in, minOut, deadline)
//   3. AccountCore.withdraw(rootId, tokenOut, amount, owner)
//
// The wallet calls the market itself, as the account's owner. The SDK does
// exactly this (simulate, then writeContract) — no EIP-7702 delegation, so no
// 10 MON reserve on the hunter's wallet.
//
// WITHDRAWALS ARE CAPPED PROTOCOL-WIDE ($200k bucket, shared by everyone), but
// each deposit adds its own USD value as withdrawal credit for 24 hours. A
// deposit -> swap -> withdraw done in minutes is covered by the hunter's own
// credit. A withdrawal that does not fit reverts whole; there is no queue.
//
// The dangerous state is new: after step 1 the hunter's funds sit INSIDE Kuru.
// Every failure past that point says so (KuruStopped.inKuru) and withdrawAll()
// is the way back out. Nothing retries on its own — the hunter decides.
// ---------------------------------------------------------------------------

import type { Abi, Hex, LocalAccount } from "viem";
import { publicClient, walletClientFor } from "./swap";
import { USDC } from "./kuru";

export const KURU_ACCOUNT_CORE =
  "0x264123a9B96Cc1193944cC25C188f1bD3dFa670e" as const;
/** MONUSDC in api.mainnet.kuru.io/api/v1/markets?status=active, 2026-10-31. */
export const KURU_MON_USDC =
  "0xc9dE998e272d59a19CEA3783C8dd44f87A86405D" as const;
/** AccountCore's name for native MON. */
export const NATIVE_MON = "0x0000000000000000000000000000000000000000" as const;

const SWAP_RESULT = {
  name: "result",
  type: "tuple",
  components: [
    { name: "amountInUsed", type: "uint128" },
    { name: "amountOut", type: "uint128" },
  ],
} as const;

export const ACCOUNT_CORE_ABI = [
  {
    type: "function",
    name: "rootAccountIdOf",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint40" }],
  },
  {
    type: "function",
    name: "deposit",
    stateMutability: "payable",
    inputs: [
      { name: "rootOwner", type: "address" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "rootAccountId", type: "uint40" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "recipient", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getBalance",
    stateMutability: "view",
    inputs: [
      { name: "accountId", type: "uint40" },
      { name: "token", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const satisfies Abi;

export const ORDER_BOOK_ABI = [
  {
    type: "function",
    name: "estimateSwap",
    stateMutability: "view",
    inputs: [
      { name: "isBuy", type: "bool" },
      { name: "amountIn", type: "uint128" },
    ],
    outputs: [SWAP_RESULT],
  },
  {
    type: "function",
    name: "swap",
    stateMutability: "nonpayable",
    inputs: [
      { name: "userId", type: "uint40" },
      { name: "isBuy", type: "bool" },
      { name: "amountIn", type: "uint128" },
      { name: "minAmountOut", type: "uint128" },
      { name: "deadline", type: "uint64" },
    ],
    outputs: [SWAP_RESULT],
  },
] as const satisfies Abi;

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
] as const satisfies Abi;

/** "sell" spends MON for USDC; "buy" spends USDC for MON. */
export type Side = "sell" | "buy";

export function legsFor(side: Side): {
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  isBuy: boolean;
} {
  // isBuy is from the BOOK's side: true spends quote (USDC) for base (MON).
  return side === "sell"
    ? { tokenIn: NATIVE_MON, tokenOut: USDC, isBuy: false }
    : { tokenIn: USDC, tokenOut: NATIVE_MON, isBuy: true };
}

/** Floor of `estimate` less `slippageBps`. Rounds DOWN so it never asks for more than quoted. */
export function minAmountOut(estimate: bigint, slippageBps: number): bigint {
  if (
    !Number.isInteger(slippageBps) ||
    slippageBps < 0 ||
    slippageBps >= 10_000
  ) {
    throw new Error(`kuru: slippage ${slippageBps} bps is not a sane value`);
  }
  return (estimate * BigInt(10_000 - slippageBps)) / 10_000n;
}

export interface SwapEstimate {
  amountInUsed: bigint;
  amountOut: bigint;
}

/**
 * Refuse a quote the book cannot fill whole.
 *
 * estimateSwap reports what it would actually USE. Less than the amount asked
 * for means the book ran out, and the unspent rest would sit in the hunter's
 * Kuru account after the swap — the exact stranded state this module exists to
 * avoid. Zero out is the empty-book case the old MON_USDC market was in.
 */
export function checkFill(est: SwapEstimate, amountIn: bigint): void {
  if (est.amountOut <= 0n) {
    throw new Error("kuru: the order book has nothing to trade against");
  }
  if (est.amountInUsed < amountIn) {
    throw new Error(
      `kuru: the order book can only fill ${est.amountInUsed} of ${amountIn} — try a smaller amount`,
    );
  }
}

export type KuruStage =
  "quoting" | "approving" | "depositing" | "swapping" | "withdrawing" | "done";

/**
 * Where a swap stopped, and where the money is because of it.
 *
 * `nothingSent` matches SwapNotStarted in kuru-swap.ts so oneclick-run.ts reads
 * both the same way. `inKuru` is the new case: funds are in the hunter's Kuru
 * account, safe and theirs, but not in their wallet until withdrawAll() runs.
 * Null means it cannot be known from here (a deposit that threw after sending).
 */
export class KuruStopped extends Error {
  readonly nothingSent: boolean;
  constructor(
    readonly stage: KuruStage,
    readonly inKuru: boolean | null,
    cause: unknown,
  ) {
    super(String((cause as { message?: string })?.message ?? cause), { cause });
    this.name = "KuruStopped";
    this.nothingSent = stage === "quoting";
  }
}

interface ContractCall {
  address: `0x${string}`;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  value?: bigint;
}

/**
 * Everything this module needs from the chain. Injected so the sequencing —
 * and above all what happens when step 2 of 3 fails — is testable without one.
 */
export interface KuruChain {
  read(call: ContractCall): Promise<unknown>;
  /** Simulate, send, wait. Throws on a revert; returns the hash on success. */
  send(call: ContractCall): Promise<Hex>;
}

export function viemChain(account: LocalAccount): KuruChain {
  const pc = publicClient();
  const wc = walletClientFor(account);
  return {
    read: (call) =>
      pc.readContract(call as Parameters<typeof pc.readContract>[0]),
    send: async (call) => {
      // Simulated first, always: Monad charges the full gas limit on a revert.
      const sim = await pc.simulateContract({
        ...(call as Parameters<typeof pc.simulateContract>[0]),
        account,
      });
      const hash = await wc.writeContract(sim.request);
      const receipt = await pc.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        throw new Error(`kuru: transaction ${hash} reverted`);
      }
      return hash;
    },
  };
}

async function estimate(
  chain: KuruChain,
  isBuy: boolean,
  amountIn: bigint,
): Promise<SwapEstimate> {
  const r = (await chain.read({
    address: KURU_MON_USDC,
    abi: ORDER_BOOK_ABI,
    functionName: "estimateSwap",
    args: [isBuy, amountIn],
  })) as SwapEstimate;
  return { amountInUsed: r.amountInUsed, amountOut: r.amountOut };
}

/** Quote only — what `amountIn` would get right now. Read-only. */
export async function quoteKuru(
  chain: Pick<KuruChain, "read">,
  side: Side,
  amountIn: bigint,
): Promise<SwapEstimate> {
  return estimate(chain as KuruChain, legsFor(side).isBuy, amountIn);
}

async function rootIdOf(
  chain: KuruChain,
  owner: `0x${string}`,
): Promise<number> {
  return Number(
    await chain.read({
      address: KURU_ACCOUNT_CORE,
      abi: ACCOUNT_CORE_ABI,
      functionName: "rootAccountIdOf",
      args: [owner],
    }),
  );
}

async function balanceIn(
  chain: KuruChain,
  rootId: number,
  token: `0x${string}`,
): Promise<bigint> {
  return (await chain.read({
    address: KURU_ACCOUNT_CORE,
    abi: ACCOUNT_CORE_ABI,
    functionName: "getBalance",
    args: [rootId, token],
  })) as bigint;
}

export interface KuruSwapV2Result {
  /** What reached the wallet, read from the Kuru balance before withdrawing. */
  amountOut: bigint;
  depositTx: Hex;
  swapTx: Hex;
  withdrawTx: Hex;
}

export async function swapOnKuru(args: {
  chain: KuruChain;
  owner: `0x${string}`;
  side: Side;
  amountIn: bigint;
  slippageBps?: number;
  /** Seconds since epoch; injected for tests. */
  nowSec?: number;
  onStep?: (s: KuruStage) => void;
  /** Fired as soon as the swap lands, before the withdrawal is attempted. */
  onSwapTx?: (hash: Hex) => void;
}): Promise<KuruSwapV2Result> {
  const { chain, owner, side, amountIn } = args;
  const step = args.onStep ?? (() => {});
  const slippageBps = args.slippageBps ?? 100;
  const { tokenIn, tokenOut, isBuy } = legsFor(side);

  if (amountIn <= 0n) {
    throw new KuruStopped(
      "quoting",
      false,
      "kuru: nothing to swap — the amount is zero",
    );
  }

  // --- quote: nothing sent yet ---------------------------------------------
  step("quoting");
  try {
    checkFill(await estimate(chain, isBuy, amountIn), amountIn);
  } catch (e) {
    throw new KuruStopped("quoting", false, e);
  }

  // --- approve (USDC only) — a transaction, but it moves no funds ----------
  if (tokenIn !== NATIVE_MON) {
    try {
      const allowance = (await chain.read({
        address: tokenIn,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [owner, KURU_ACCOUNT_CORE],
      })) as bigint;
      if (allowance < amountIn) {
        step("approving");
        // Exactly this amount, never unbounded.
        await chain.send({
          address: tokenIn,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [KURU_ACCOUNT_CORE, amountIn],
        });
      }
    } catch (e) {
      throw new KuruStopped("approving", false, e);
    }
  }

  // --- deposit -------------------------------------------------------------
  step("depositing");
  let depositTx: Hex;
  try {
    depositTx = await chain.send({
      address: KURU_ACCOUNT_CORE,
      abi: ACCOUNT_CORE_ABI,
      functionName: "deposit",
      args: [owner, tokenIn, amountIn],
      value: tokenIn === NATIVE_MON ? amountIn : 0n,
    });
  } catch (e) {
    // A send can reach the chain and still throw while waiting. Unknown.
    throw new KuruStopped("depositing", null, e);
  }

  // --- swap: from here on the funds are in Kuru until withdrawn ------------
  step("swapping");
  let swapTx: Hex;
  let rootId: number;
  try {
    rootId = await rootIdOf(chain, owner);
    if (rootId === 0)
      throw new Error("kuru: deposit landed but no account exists");
    // Re-quoted after the deposit: the hunter may have spent a minute on it.
    const fresh = await estimate(chain, isBuy, amountIn);
    checkFill(fresh, amountIn);
    swapTx = await chain.send({
      address: KURU_MON_USDC,
      abi: ORDER_BOOK_ABI,
      functionName: "swap",
      args: [
        rootId,
        isBuy,
        amountIn,
        minAmountOut(fresh.amountOut, slippageBps),
        BigInt((args.nowSec ?? Math.floor(Date.now() / 1000)) + 120),
      ],
    });
  } catch (e) {
    throw new KuruStopped("swapping", true, e);
  }
  args.onSwapTx?.(swapTx);

  // --- withdraw the proceeds ---------------------------------------------
  step("withdrawing");
  let amountOut: bigint;
  let withdrawTx: Hex;
  try {
    amountOut = await balanceIn(chain, rootId, tokenOut);
    withdrawTx = await chain.send({
      address: KURU_ACCOUNT_CORE,
      abi: ACCOUNT_CORE_ABI,
      functionName: "withdraw",
      args: [rootId, tokenOut, amountOut, owner],
    });
  } catch (e) {
    throw new KuruStopped("withdrawing", true, e);
  }

  step("done");
  return { amountOut, depositTx, swapTx, withdrawTx };
}

/**
 * Move everything in the hunter's Kuru account back to their wallet.
 *
 * The way out of every `inKuru` failure, and safe to call any time: it reads
 * each balance and withdraws only what is there. Returns the hashes sent.
 */
export async function withdrawAll(args: {
  chain: KuruChain;
  owner: `0x${string}`;
}): Promise<Hex[]> {
  const { chain, owner } = args;
  const rootId = await rootIdOf(chain, owner);
  if (rootId === 0) return [];
  const sent: Hex[] = [];
  for (const token of [NATIVE_MON, USDC] as const) {
    const bal = await balanceIn(chain, rootId, token);
    if (bal <= 0n) continue;
    sent.push(
      await chain.send({
        address: KURU_ACCOUNT_CORE,
        abi: ACCOUNT_CORE_ABI,
        functionName: "withdraw",
        args: [rootId, token, bal, owner],
      }),
    );
  }
  return sent;
}
