// ---------------------------------------------------------------------------
// EIP-712 typed data for a Cota — the upper bound a player signs before any
// software may trade on their behalf.
//
// Kept in lib/cota rather than folded into lib/auth/typedData.ts on purpose.
// The signatures in lib/auth authorise an action the player is taking right
// now (a claim, a registration, a login). A Cota authorises actions somebody
// ELSE will take later, inside limits the player set. Same domain, same
// machinery, different thing being promised — and the file boundary says so.
//
// The domain is imported, not redeclared. A second copy of HUNT_DOMAIN would
// be a second thing to keep in sync, and a drifted domain separator recovers a
// different address, which fails as "wrong signer" — the least informative way
// this could possibly break.
// ---------------------------------------------------------------------------

import { hashTypedData } from "viem";
import { HUNT_DOMAIN } from "@/lib/auth/typedData";

export { HUNT_DOMAIN };

export const COTA_TYPES = {
  Cota: [
    // Which venue this bound authorises. A Cota signed for one venue must not
    // authorise trading on another: "I am copying spot, worst case the token
    // goes to zero" and "I am trading perps, I can be liquidated" are
    // different agreements about how much can go wrong.
    { name: "venue", type: "string" },

    // Named markets, not a wildcard. Following someone for their MON calls is
    // not consent to their memecoin ones.
    { name: "markets", type: "string[]" },

    // The ceilings. Scaled integers rather than strings because each is
    // COMPARED against a fill later — see lib/cota/scale.ts for why that
    // differs from how lat/lng are signed.
    { name: "maxNotionalUsdE6", type: "uint256" },
    { name: "maxLeverageX100", type: "uint256" },

    // The one that does the real work. Bounding how often software trades is
    // enough for software you wrote. When the thing on the other side can lose
    // money faster than you can watch it, the only number that protects you is
    // how much it may lose before it must stop.
    { name: "maxDailyLossUsdE6", type: "uint256" },

    { name: "maxTradesPerDay", type: "uint32" },

    // Unix seconds. A bound with no expiry is a bound nobody revisits.
    { name: "notBefore", type: "uint64" },
    { name: "notAfter", type: "uint64" },

    // Replay protection, identical in shape and meaning to every other signed
    // intent in this codebase. clientTs must sit inside the clock-skew window
    // and nonce is single-use, so a captured signature has a bounded life.
    { name: "clientTs", type: "uint256" },
    { name: "nonce", type: "string" },
  ],
} as const;

/** Venues a Cota may name. Adding one is a deliberate act, not a string. */
export const COTA_VENUES = ["perpl"] as const;
export type CotaVenue = (typeof COTA_VENUES)[number];

export function isCotaVenue(v: string): v is CotaVenue {
  return (COTA_VENUES as readonly string[]).includes(v);
}

/** The signed message, exactly as it goes to the wallet and to the hasher. */
export interface CotaMessage {
  venue: CotaVenue;
  markets: readonly string[];
  maxNotionalUsdE6: bigint;
  maxLeverageX100: bigint;
  maxDailyLossUsdE6: bigint;
  maxTradesPerDay: number;
  notBefore: bigint;
  notAfter: bigint;
  /** Unix SECONDS. */
  clientTs: bigint;
  nonce: string;
}

/**
 * The EIP-712 digest of a Cota — the value stored in `Cota.digest`.
 *
 * A pure function of the message, computed the same way on the signing side
 * and the storing side. It exists as its own export rather than being returned
 * by the verifier because the two answer different questions: the verifier says
 * WHO signed, this says WHICH agreement. Conflating them would mean a row could
 * only ever be keyed by a digest some other function happened to hand back.
 *
 * The uniqueness of this value is what stops one agreement existing twice —
 * where one copy could be revoked while its twin stayed live.
 */
export function cotaDigest(message: CotaMessage): `0x${string}` {
  return hashTypedData({
    domain: HUNT_DOMAIN,
    types: COTA_TYPES,
    primaryType: "Cota",
    message: {
      venue: message.venue,
      markets: [...message.markets],
      maxNotionalUsdE6: message.maxNotionalUsdE6,
      maxLeverageX100: message.maxLeverageX100,
      maxDailyLossUsdE6: message.maxDailyLossUsdE6,
      maxTradesPerDay: message.maxTradesPerDay,
      notBefore: message.notBefore,
      notAfter: message.notAfter,
      clientTs: message.clientTs,
      nonce: message.nonce,
    },
  });
}
