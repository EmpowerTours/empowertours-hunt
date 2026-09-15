// Every venue-side reason an order cannot fill, asked BEFORE the order is sent.
//
// This module exists because the same bug has now happened three times, and each
// time it presented identically: the gateway acks with code 0, the chain does
// nothing, and the hunter reads "Accepted (not filled yet)" forever.
//
//   - `fw:false` — forwarding off. A fresh account defaults to it. Cost: an
//     evening, and two accounts (5273, and Mandate's 5103 before it).
//   - `rq:1` — a stale idempotency key. Account 5273 filled once and then every
//     order after it was silently dead. Cost: the executor looked broken again
//     days after it was fixed.
//   - the agent order id that made the trades-per-day ceiling answer 1 forever.
//
// All three were readable off the mt 19 account frame, which the client has had
// in hand since sign-in. Three bugs from one blind spot is not bad luck, it is a
// missing check — so this is the one place that reads that frame and names what
// it finds, and the trade route calls it instead of testing flags one at a time.
//
// The rule this encodes: a venue-side fact that can stop a fill is refused here,
// loudly and by name, or it will be discovered later as a silent non-fill.

import type { AccountSnapshot } from "./frames";

/**
 * A venue-side condition that makes a fill impossible. Ordered most fundamental
 * first — a frozen account cannot trade whatever else is true of it.
 */
export type VenueRefusal =
  | "account_frozen"
  | "forwarding_disabled"
  | "no_collateral";

/**
 * The first venue-side reason this account cannot fill an order, or null if the
 * venue has no standing objection.
 *
 * A null account is NOT a refusal. The venue named no account for this key — a
 * condition `placeOrder` reports on its own — and refusing here would block a
 * hunter on a frame we failed to read rather than on a flag the venue actually
 * set. Fail closed on state we must judge; do not invent state we failed to get.
 */
export function venuePreflight(
  account: AccountSnapshot | null,
): VenueRefusal | null {
  if (!account) return null;
  if (account.frozen) return "account_frozen";
  if (!account.forwardingAllowed) return "forwarding_disabled";
  // Scaled micro-units, the same scale the balance arrives in (`b:"10620689"`
  // is 10.620689). At or below zero there is nothing to post margin against and
  // no order can fill, whatever its size.
  //
  // DELIBERATELY NOT a margin check. Refusing on "notional x initial_margin >
  // available" needs the market's own `initial_margin` and fee tier, and a
  // formula guessed here would refuse orders the venue would have filled —
  // trading a silent non-fill for a false refusal. The venue is the authority on
  // whether collateral suffices; this only catches the case where the answer
  // cannot be yes.
  if (account.available <= 0) return "no_collateral";
  return null;
}

/**
 * The English `detail` returned alongside the reason code, for API consumers —
 * the Python agent reads these out of logs. The browser prefers the bilingual
 * table in `lib/cota/denial-text.ts`. Typed as an exhaustive Record so a new
 * VenueRefusal cannot be added without a sentence explaining it.
 */
export const VENUE_REFUSAL_DETAIL: Record<VenueRefusal, string> = {
  account_frozen:
    "this Perpl account is frozen at the venue (fr:true), so it cannot trade at all; nothing was sent",
  forwarding_disabled:
    "this Perpl account has order forwarding disabled (fw:false), so the venue accepts orders it will never execute; nothing was sent",
  no_collateral:
    "this Perpl account has no free collateral (balance - locked <= 0), so an order would be accepted and never filled; nothing was sent",
};
