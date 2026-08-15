// Display helpers for the operator console.
//
// The only rule that matters here: a wei value NEVER passes through `Number()`.
// 1 MON is 1e18 wei and Number.MAX_SAFE_INTEGER is ~9.007e15, so `Number(wei)`
// silently rounds. A rounding error on this screen is a rounding error in a
// payout, and it would look completely plausible.
//
// Everything below takes a Prisma Decimal or a bigint and goes through
// lib/wei.ts. There is no numeric shortcut in this file.

import type { Prisma } from "@prisma/client";
import { formatMon, toWei } from "@/lib/wei";

/**
 * Decimal -> bigint, tolerating a negative value.
 *
 * `toWei` refuses negatives on purpose (a negative payout is a bug), but
 * CreditLedger.amountWei is signed by design — a revocation is a negative
 * entry. So the sign is peeled off, the magnitude validated, and the sign
 * reapplied.
 */
export function signedWei(d: Prisma.Decimal): bigint {
  const s = d.toFixed(0);
  return s.startsWith("-") ? -toWei(s.slice(1)) : toWei(s);
}

/** Unsigned Decimal column -> bigint. Throws on a negative, which is correct. */
export function weiOf(d: Prisma.Decimal): bigint {
  return toWei(d);
}

/** Sum a nullable Prisma `_sum` aggregate without touching Number. */
export function sumWei(d: Prisma.Decimal | null | undefined): bigint {
  if (d === null || d === undefined) return 0n;
  return signedWei(d);
}

/** "0.001 MON". Never abbreviated — an operator reads exact amounts here. */
export function mon(value: bigint | Prisma.Decimal): string {
  const v = typeof value === "bigint" ? value : signedWei(value);
  const neg = v < 0n;
  return `${neg ? "-" : ""}${formatMon(neg ? -v : v)} MON`;
}

/** Same, for TURBO credit — denominated in WMON-wei, not withdrawable. */
export function wmon(value: bigint | Prisma.Decimal): string {
  const v = typeof value === "bigint" ? value : signedWei(value);
  const neg = v < 0n;
  return `${neg ? "-" : ""}${formatMon(neg ? -v : v)} WMON`;
}

export function shortAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function timestamp(d: Date | null | undefined): string {
  if (!d) return "—";
  return d.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

export function relative(d: Date | null | undefined, now = new Date()): string {
  if (!d) return "—";
  const ms = now.getTime() - d.getTime();
  const abs = Math.abs(ms);
  const suffix = ms >= 0 ? "ago" : "from now";
  const units: [number, string][] = [
    [86_400_000, "d"],
    [3_600_000, "h"],
    [60_000, "m"],
    [1000, "s"],
  ];
  for (const [size, label] of units) {
    if (abs >= size) return `${Math.floor(abs / size)}${label} ${suffix}`;
  }
  return "just now";
}

/**
 * Ratio of two wei values as a percentage, computed in bigint and only then
 * narrowed to a display number. Returns null when the denominator is zero
 * rather than producing Infinity or NaN in the UI.
 */
export function pctOfWei(part: bigint, whole: bigint): number | null {
  if (whole <= 0n) return null;
  // Scale by 10_000 first so the integer division keeps two decimal places.
  return Number((part * 10_000n) / whole) / 100;
}

export function meters(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${v.toFixed(1)} m`;
}

export function kmh(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${v.toFixed(1)} km/h`;
}
