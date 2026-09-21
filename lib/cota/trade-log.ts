import { formatEther, formatUnits } from "viem";

// ---------------------------------------------------------------------------
// Turning a stored trade into a line a hunter can read.
//
// The rules here are small and every one of them is a place where the obvious
// implementation states something false. A buy that received MON shows no
// Transfer event, so "you received 0" is wrong. A revert delivered nothing but
// still cost the whole gas limit, so showing it as a trade with no amount is
// wrong. And a trade that went through a pool must not inherit the screen's
// "on Kuru's order book" label just because the screen was showing it when the
// button was pressed.
//
// Pure. The page renders; this decides what is true.
// ---------------------------------------------------------------------------

/** One row as the history endpoint serves it. Wei arrive as decimal strings. */
export interface TradeRow {
  hash: string;
  ok: boolean;
  side: string;
  gasWei: string;
  valueWei: string;
  tokensIn: Record<string, string>;
  crossedOrderBook: boolean;
  at: string;
}

export const USDC_ADDRESS =
  "0x754704bc059f8c67012fed69bc8a327a5aafb603" as const;

export type Outcome =
  /** Filled, and we can say exactly what arrived. */
  | { kind: "received"; units: bigint; decimals: number; symbol: string }
  /** Filled, but the amount is not recoverable from a receipt. */
  | { kind: "filled-amount-unknown" }
  /** Reverted. Cost gas, delivered nothing. */
  | { kind: "reverted" };

/**
 * What this trade did.
 *
 * The `filled-amount-unknown` case is the one that matters and the one an
 * obvious implementation loses. Buying MON pays out in the NATIVE token, which
 * moves no Transfer event, so the receipt genuinely does not contain the
 * amount — recovering it needs a balance diff across the block, a much heavier
 * call than reading a receipt, and one that is wrong anyway because the gas
 * came out of the same balance.
 *
 * Reporting zero there would be a lie in the hunter's disfavour on every
 * successful buy they ever make. Saying "we can't show the amount" is worse
 * copy and true.
 */
export function outcomeOf(row: TradeRow): Outcome {
  if (!row.ok) return { kind: "reverted" };
  const usdc = row.tokensIn[USDC_ADDRESS];
  if (usdc !== undefined && BigInt(usdc) > 0n) {
    return {
      kind: "received",
      units: BigInt(usdc),
      decimals: 6,
      symbol: "USDC",
    };
  }
  const other = Object.entries(row.tokensIn).find(([, u]) => BigInt(u) > 0n);
  if (other) {
    // An unrecognised token: show the units rather than pretend to know the
    // decimals. Kuru can route to a token this screen has never heard of.
    return {
      kind: "received",
      units: BigInt(other[1]),
      decimals: 0,
      symbol: "",
    };
  }
  return { kind: "filled-amount-unknown" };
}

/** Gas actually paid, in MON. On Monad this is the whole limit — never a cap. */
export function gasMon(row: TradeRow): string {
  return trim(formatEther(BigInt(row.gasWei)), 6);
}

/** MON sent with the call. Zero on a buy, which spends USDC instead. */
export function spentMon(row: TradeRow): string {
  return trim(formatEther(BigInt(row.valueWei)), 6);
}

export function receivedText(o: Outcome): string | null {
  if (o.kind !== "received") return null;
  const n =
    o.decimals === 0
      ? o.units.toString()
      : trim(formatUnits(o.units, o.decimals), 6);
  return o.symbol ? `${n} ${o.symbol}` : n;
}

/**
 * Gas as a share of what was traded, in basis points.
 *
 * The number that makes the whole log worth reading. Gas on Monad is a fixed
 * cost per trade, so it is invisible in absolute terms and enormous in relative
 * ones: the same 0.06 MON is 1.2% of a 5 MON trade and 0.01% of a 500 MON one.
 * A hunter who cannot see this has no way to learn that their trades are too
 * small, which was true of the first real one.
 *
 * Null when there is nothing to divide by — a buy spends USDC, so `valueWei` is
 * zero and the ratio would be a division by zero dressed up as a fact.
 */
export function gasBps(row: TradeRow): number | null {
  const value = BigInt(row.valueWei);
  if (value <= 0n) return null;
  return Number((BigInt(row.gasWei) * 10_000n * 100n) / value) / 100;
}

/** Trailing zeros make a column of numbers unreadable on a phone. */
function trim(s: string, places: number): string {
  if (!s.includes(".")) return s;
  const [whole, frac] = s.split(".");
  const cut = frac.slice(0, places).replace(/0+$/, "");
  return cut.length ? `${whole}.${cut}` : whole;
}
