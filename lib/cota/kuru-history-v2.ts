// ---------------------------------------------------------------------------
// Recording a trade made through Kuru's relaunched exchange (kuru-v2.ts).
//
// A v2 trade is three transactions — deposit, swap, withdraw — where the old
// route was one. The row still describes ONE trade, keyed by the SWAP hash,
// in the same shape the old decoder wrote, so mon-moved and spot-pnl read old
// and new rows identically and never have to know which is which:
//
//   valueWei     MON sold        (sell)  — 0 on a buy
//   nativeInWei  MON received    (buy)   — 0 on a sell, null if unknown
//   tokensIn     USDC received   (sell)
//   tokensOut    USDC spent      (buy)
//   gasWei       gas of ALL the trade's transactions, not just the swap
//
// As before, the client only NAMES transactions. Every amount comes off the
// chain: what the swap was asked to do from its calldata, what it actually
// did from its return value in a trace. A trace we cannot get leaves the
// output unknown rather than zero.
// ---------------------------------------------------------------------------

import { decodeFunctionData, decodeFunctionResult, type Hex } from "viem";
import { USDC } from "./kuru";
import {
  ACCOUNT_CORE_ABI,
  KURU_ACCOUNT_CORE,
  KURU_MON_USDC,
  ORDER_BOOK_ABI,
} from "./kuru-v2";
import {
  NotAKuruTrade,
  gasChargedWei,
  type MinimalReceipt,
  type TradeRecord,
} from "./kuru-history";

/** One transaction as the route fetched it: its receipt plus its calldata. */
export interface ChainTx {
  receipt: Pick<
    MinimalReceipt,
    "status" | "from" | "to" | "blockNumber" | "gasUsed" | "effectiveGasPrice"
  >;
  input: Hex;
}

const lower = (s: string | null | undefined) => (s ?? "").toLowerCase();

function decodeSwap(input: Hex) {
  const d = decodeFunctionData({ abi: ORDER_BOOK_ABI, data: input });
  if (d.functionName !== "swap")
    throw new NotAKuruTrade("that is not a Kuru swap");
  const [, isBuy, amountIn] = d.args as readonly [
    number,
    boolean,
    bigint,
    bigint,
    bigint,
  ];
  return { isBuy, amountIn };
}

/** The swap's own return value, from a callTracer frame's `output`. Null if absent. */
export function swapResultFromOutput(
  output: Hex | null | undefined,
): { amountInUsed: bigint; amountOut: bigint } | null {
  if (!output || output === "0x") return null;
  try {
    const r = decodeFunctionResult({
      abi: ORDER_BOOK_ABI,
      functionName: "swap",
      data: output,
    }) as { amountInUsed: bigint; amountOut: bigint };
    return { amountInUsed: r.amountInUsed, amountOut: r.amountOut };
  } catch {
    return null;
  }
}

/** A deposit or withdrawal is only counted if it is this wallet's, to Kuru. */
function checkAccountTx(
  name: "deposit" | "withdraw",
  t: ChainTx,
  wallet: string,
): void {
  if (
    lower(t.receipt.from) !== wallet ||
    lower(t.receipt.to) !== lower(KURU_ACCOUNT_CORE)
  ) {
    throw new NotAKuruTrade(`that ${name} was not this wallet's, to Kuru`);
  }
  const d = decodeFunctionData({ abi: ACCOUNT_CORE_ABI, data: t.input });
  if (d.functionName !== name)
    throw new NotAKuruTrade(`that is not a Kuru ${name}`);
  // deposit(owner, …) credits `owner`; withdraw(…, recipient) pays `recipient`.
  const party = name === "deposit" ? d.args[0] : d.args[3];
  if (lower(party as string) !== wallet) {
    throw new NotAKuruTrade(`that ${name} was for a different wallet`);
  }
}

export function toRecordV2(args: {
  hash: string;
  side: "buy" | "sell";
  swap: ChainTx;
  /** Return data of the swap call, from a trace. Null when no trace was available. */
  swapOutput: Hex | null;
  deposit?: ChainTx;
  withdraw?: ChainTx;
}): TradeRecord {
  const { swap, side } = args;
  const wallet = lower(swap.receipt.from);
  if (lower(swap.receipt.to) !== lower(KURU_MON_USDC)) {
    throw new NotAKuruTrade(
      "that transaction did not go to Kuru's MON/USDC book",
    );
  }
  const { isBuy, amountIn } = decodeSwap(swap.input);
  if (isBuy !== (side === "buy")) {
    throw new NotAKuruTrade(
      `that swap was a ${isBuy ? "buy" : "sell"}, not a ${side}`,
    );
  }
  if (args.deposit) checkAccountTx("deposit", args.deposit, wallet);
  if (args.withdraw) checkAccountTx("withdraw", args.withdraw, wallet);

  const gasWei = [args.deposit, swap, args.withdraw]
    .filter((t): t is ChainTx => t !== undefined)
    .reduce((sum, t) => sum + gasChargedWei(t.receipt), 0n);

  const ok = swap.receipt.status === "success";
  const base = {
    hash: args.hash.toLowerCase(),
    wallet,
    ok,
    blockNumber: swap.receipt.blockNumber,
    gasWei,
    // The book IS the venue in v2; nothing can route around it.
    crossedOrderBook: ok,
  };
  // A revert moved nothing. Known zero, not unknown.
  if (!ok) {
    return {
      ...base,
      valueWei: 0n,
      tokensIn: {},
      tokensOut: {},
      nativeInWei: 0n,
    };
  }

  const result = swapResultFromOutput(args.swapOutput);
  const usdc = USDC.toLowerCase();
  if (side === "sell") {
    return {
      ...base,
      // Exact when traced; otherwise the calldata's amount, which kuru-v2
      // only ever sends after checking the book fills it whole.
      valueWei: result?.amountInUsed ?? amountIn,
      tokensIn: result ? { [usdc]: result.amountOut } : {},
      tokensOut: {},
      nativeInWei: 0n,
    };
  }
  return {
    ...base,
    valueWei: 0n,
    tokensIn: {},
    tokensOut: { [usdc]: result?.amountInUsed ?? amountIn },
    nativeInWei: result ? result.amountOut : null,
  };
}
