/* ---------------------------------------------------------------------------
   Display formatting.

   Wei is bigint, never number. Every function here does integer arithmetic and
   string slicing; nothing touches parseFloat, Number() or toFixed on a wei
   value. A rounding error in this file is a rounding error a player reads as
   their balance.

   This duplicates the display half of `lib/wei.ts` (payout lane), which does
   not exist yet. When it lands, `formatMon` here should delegate to it and this
   comment should be the thing that reminds someone to do that.
--------------------------------------------------------------------------- */

const WEI_PER_MON = 10n ** 18n;

/** One month of TURBO Explorer, in WMON-wei. The credit ladder's unit. */
export const TURBO_MONTH_WEI = 139n * WEI_PER_MON;

/**
 * Parse a decimal wei string. Returns null for anything that is not a plain
 * base-10 integer — "1e18", "0x10", "" and " 5 " are all rejected rather than
 * coerced, because a coerced balance is a wrong balance shown confidently.
 */
export function parseWei(
  value: string | bigint | null | undefined,
): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value !== "string") return null;
  if (!/^-?\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/** Same as parseWei but folds an unparseable value to 0n for display paths. */
export function weiOrZero(value: string | bigint | null | undefined): bigint {
  return parseWei(value) ?? 0n;
}

/**
 * wei -> human MON string. Trailing zeros trimmed, never scientific notation.
 * `1000000000000000n` -> `"0.001"`.
 */
export function formatMon(value: bigint, maxDecimals = 4): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;

  const whole = abs / WEI_PER_MON;
  const fraction = abs % WEI_PER_MON;

  let out = whole.toString();

  if (maxDecimals > 0 && fraction > 0n) {
    const padded = fraction.toString().padStart(18, "0").slice(0, maxDecimals);
    const trimmed = padded.replace(/0+$/, "");
    if (trimmed.length > 0) out += `.${trimmed}`;
  }

  // A non-zero amount that rounds to "0" at this precision is a lie by
  // truncation. Say it is small instead of saying it is nothing.
  if (out === "0" && abs > 0n) return negative ? "-<0.0001" : "<0.0001";

  return negative ? `-${out}` : out;
}

/** Percentage of a TURBO month covered by a credit balance, 0-100, one dp. */
export function turboProgressPercent(creditWei: bigint): number {
  if (creditWei <= 0n) return 0;
  if (creditWei >= TURBO_MONTH_WEI) return 100;
  // Scale by 1000 in integer space, then divide once in float. The bigint never
  // exceeds Number.MAX_SAFE_INTEGER after the division.
  return Number((creditWei * 1000n) / TURBO_MONTH_WEI) / 10;
}

/* --- Distances and clocks ------------------------------------------------- */

export function formatMeters(m: number): string {
  if (!Number.isFinite(m)) return "—";
  if (m < 10) return `${m.toFixed(1)} m`;
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10_000 ? 2 : 1)} km`;
}

/** `mm:ss`, floored at 00:00. Used for spawn expiry. */
export function formatCountdown(msRemaining: number): string {
  if (!Number.isFinite(msRemaining) || msRemaining <= 0) return "00:00";
  const total = Math.floor(msRemaining / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}h${String(minutes % 60).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** Age of a GPS fix, for the honesty readout on the scope. */
export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 1) return "now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

export function shortAddress(address: string | null): string {
  if (!address || address.length < 10) return "—";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** IPFS CID -> a fetchable URL. Gateway is overridable per environment. */
export function ipfsUrl(cid: string): string {
  const gateway =
    process.env.NEXT_PUBLIC_IPFS_GATEWAY?.replace(/\/+$/, "") ??
    "https://ipfs.io/ipfs";
  const clean = cid.replace(/^ipfs:\/\//, "").replace(/^\/+/, "");
  return `${gateway}/${clean}`;
}
