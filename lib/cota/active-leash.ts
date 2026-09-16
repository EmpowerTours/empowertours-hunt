// Which leash governs a hunter's real orders — defined ONCE, for both sides.
//
// This rule has already drifted twice. The trade route and the trade page each
// grew their own version of "find the active Cota", and a page that previews
// against one leash while the server enforces another is the failure bound.ts
// exists to prevent, arriving through selection instead of through the bound
// fields. So the predicate and the query live here, next to each other, with a
// test that holds them to the same answer.
//
// Three conditions, each of which was a real defect when it was missing:
//
//   NOT REVOKED — the only one that was ever right.
//
//   ANCHORED — a practice leash is signed but never put on chain and is stored
//   in this same table with a null anchorTxHash. Without this, signing one in
//   practice mode silently makes it the authority for real orders. Practice is
//   the mode that costs nothing and authorises nothing; the anchor is what makes
//   a bound verifiable by someone who does not trust this database, which is the
//   whole claim Cota makes.
//
//   NAMES A REACHABLE MARKET — a leash naming only BTC authorises nothing this
//   executor can build an order for. Selecting it because it is newest refuses
//   every order with market_not_authorised while a usable leash sits behind it.

import { executableSymbols } from "./order";

export interface LeashRow {
  revokedAt: string | Date | null;
  anchorTxHash: string | null;
  markets: string[];
}

/** Does this leash govern real orders? The client-side half of the rule. */
export function governsLiveOrders(c: LeashRow): boolean {
  if (c.revokedAt !== null) return false;
  if (c.anchorTxHash === null) return false;
  const reachable = new Set(executableSymbols());
  return c.markets.some((m) => reachable.has(m));
}

/** The market on a leash that this executor can actually trade. */
export function tradableMarketOf(c: LeashRow): string | null {
  const reachable = new Set(executableSymbols());
  return c.markets.find((m) => reachable.has(m)) ?? null;
}

/**
 * The Prisma filter for the same rule — the server-side half.
 *
 * Kept beside the predicate so the two are edited together, and asserted
 * equivalent in active-leash.test.ts. A change to one that is not made to the
 * other fails there rather than in production.
 */
export function liveLeashWhere(playerId: string) {
  return {
    playerId,
    revokedAt: null,
    anchorTxHash: { not: null },
    markets: { hasSome: executableSymbols() },
  } as const;
}
