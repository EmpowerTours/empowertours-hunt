// One place to turn a Cota row into the EnforcedBound the gate checks against.
//
// The row comes from two shapes: the DB (Prisma Decimals + Date columns, server
// routes) and the client (plain strings, the trade page). Accept both, so the
// trade route, propose route and trade page can never gate against a
// differently-built bound — a drift that would let the UI preview "allowed"
// while the server refuses, or worse, the reverse.

import type { EnforcedBound } from "./enforce";

/** A Cota row from the DB (Decimal/Date) or the client (string). */
export interface CotaBoundRow {
  venue: string;
  markets: string[];
  maxNotionalUsdE6: string | { toString(): string };
  maxLeverageX100: string | { toString(): string };
  maxDailyLossUsdE6: string | { toString(): string };
  maxTradesPerDay: number;
  notBefore: string | Date;
  notAfter: string | Date;
  revokedAt: string | Date | null;
}

const toUnixSeconds = (d: string | Date): bigint =>
  BigInt(Math.floor(new Date(d).getTime() / 1000));

export function boundFromRow(c: CotaBoundRow): EnforcedBound {
  return {
    venue: c.venue,
    markets: c.markets,
    maxNotionalUsdE6: BigInt(c.maxNotionalUsdE6.toString()),
    maxLeverageX100: BigInt(c.maxLeverageX100.toString()),
    maxDailyLossUsdE6: BigInt(c.maxDailyLossUsdE6.toString()),
    maxTradesPerDay: c.maxTradesPerDay,
    notBefore: toUnixSeconds(c.notBefore),
    notAfter: toUnixSeconds(c.notAfter),
    revokedAt: c.revokedAt ? new Date(c.revokedAt) : null,
  };
}
