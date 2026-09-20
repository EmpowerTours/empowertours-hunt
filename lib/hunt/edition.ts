// The edition mechanic — random, VISIBLE, ephemeral drops of an fcempowertours
// work that a hunter can take.
//
// Written as a pure module for the same reason lib/hunt/spawn.ts and
// lib/hunt/validator.ts are: the decision logic takes no DB, no network and no
// clock, so a dispute is answered by replaying stored rows through these
// functions rather than by anyone's recollection.
//
// WHAT THIS IS NOT
//
// It is not a spawn. A spawn GIVES native MON and every budget, per-payout cap
// and rolling 24h ceiling in the schema exists to bound money leaving the
// treasury. An edition either gives a licence — not fungible, not partially
// payable — or ASKS the hunter for money. Same finding mechanics, opposite
// direction of value.
//
// WHAT IT DELIBERATELY REUSES
//
// Placement, secrecy posture and the commit-reveal are spawn's, unchanged:
//
//   * placement is an annulus around `PlayerHunt.lastVerifiedLat/Lng` — the
//     last position the VERIFIER accepted, never a self-reported one. The
//     caller passes that origin; this module never guesses it.
//   * a minimum radius, so taking one always costs real movement.
//   * coordinates are public the moment the blip is drawn, so the control is
//     movement and money, not concealment.
//   * commit-reveal over the seed, so the drop was demonstrably fixed before
//     the player moved.
//
// WHERE IT DIFFERS FROM A SPAWN, AND WHY IT MATTERS
//
// For a spawn the seed decides position AND amount. For an edition the seed
// decides position AND WHICH WORK — the price is not random, it comes from the
// venue. So the reveal proves the placement and the choice of work, and the
// price is proven a different way: it is written onto the row at placement and
// honoured for the life of the drop (see quoting, below).

import { destinationPoint, uniformBigInt } from "@/lib/hunt/spawn";
import type { LatLng } from "@/lib/geo/distance";
import { affordableWithGas } from "@/lib/editions/payment";

// ---------------------------------------------------------------------------
// Reasons
// ---------------------------------------------------------------------------

/**
 * Why a player may not be offered an edition right now. Like the spawn deny
 * list, nothing here is an accusation — most of it is "not yet".
 */
export const EDITION_DENY_REASONS = [
  "editions_disabled",
  "player_not_active",
  "hunt_not_active",
  "no_verified_position",
  "stale_verified_position",
  "edition_cooldown",
  "edition_already_active",
  // Every work in the catalogue is already owned by this passkey. The rule is
  // one of each, forever, so a completist legitimately runs out. Not terminal:
  // a new work in the catalogue makes them eligible again.
  "catalogue_exhausted",
  // The catalogue could not be read. Distinct from an empty catalogue on
  // purpose: "we do not know what exists" must never be reported to a player
  // as "there is nothing", and must not be cached as a negative.
  "catalogue_unavailable",
] as const;
export type EditionDenyReason = (typeof EDITION_DENY_REASONS)[number];

/**
 * Why taking an edition was refused. The movement checks mirror
 * lib/hunt/spawn.ts exactly — same names, same thresholds, same Hunt columns —
 * because an edition must not be an easier door than a spawn is.
 */
export const EDITION_REJECT_REASONS = [
  "player_not_active",
  "hunt_not_active",
  "gps_accuracy_too_low",
  "clock_skew",
  "implausible_speed",
  "edition_not_found",
  "edition_expired",
  "edition_already_taken",
  "out_of_range",
  // The passkey already holds this work. Enforced by the unique index on
  // EditionClaim, so this is what that constraint violation is rendered as.
  "already_owned",
  // Decided by the atomic conditional UPDATE that debits hunt earnings, not
  // here — same convention spawn.ts uses for its ceiling reasons.
  "insufficient_earnings",
  // The venue would not sell at the quoted price. Kept distinct from a generic
  // failure because it is the one rejection that is nobody's fault and is
  // fixed by re-placing rather than by the hunter doing anything.
  "price_moved",
  "contended",
] as const;
export type EditionRejectReason = (typeof EDITION_REJECT_REASONS)[number];

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

export type EditionKind = "MUSIC" | "ART";
/**
 * The two things the venue will sell for one master. STANDARD is uncapped and
 * cheap; COLLECTOR has its own price and its own supply cap. A hunter may hold
 * one of each, which is why tier is part of the claim key.
 */
export type EditionTier = "STANDARD" | "COLLECTOR";
export type EditionTerms = "FREE" | "PURCHASE";

/**
 * One offerable work, as the caller has already read it from the venue.
 *
 * This module never fetches. The catalogue is supplied so that the draw stays
 * pure and replayable, and so the on-chain read can be cached, batched or
 * mocked without touching the decision logic.
 */
export interface EditionOffer {
  /** The contract the work lives in — today the v3 LicenseRegistry. */
  collection: string;
  /** The master id within that collection. */
  masterId: string;
  kind: EditionKind;
  tier: EditionTier;
  terms: EditionTerms;
  /**
   * WMON wei. Null only when terms is FREE, mirroring the database CHECK
   * constraint `Edition_terms_price_agree`.
   */
  priceWei: bigint | null;
}

/**
 * A stable ordering of the catalogue, so a revealed seed picks the same work
 * on replay as it did on the day.
 *
 * The venue has no inherent order and a caller could hand these over in
 * whatever sequence an RPC returned them. Sorting here rather than trusting
 * the caller is what makes the reveal meaningful: without it, "the seed chose
 * index 3" proves nothing, because index 3 was a different work yesterday.
 */
export function canonicalOrder(
  catalogue: readonly EditionOffer[],
): EditionOffer[] {
  // Tier is part of the ordering for the same reason it is part of the claim
  // key: the same master appears twice, once per tier, and "the seed chose
  // index 3" has to mean one of them and always the same one.
  return [...catalogue].sort(
    (a, b) =>
      a.collection.localeCompare(b.collection) ||
      a.masterId.localeCompare(b.masterId) ||
      a.tier.localeCompare(b.tier),
  );
}

// ---------------------------------------------------------------------------
// The draw
// ---------------------------------------------------------------------------

export interface EditionDrawParams {
  origin: LatLng;
  minRadiusM: number;
  maxRadiusM: number;
  /**
   * What this player may be offered: the catalogue MINUS everything their
   * passkey already holds. Filtering before the draw rather than re-rolling
   * after it keeps the draw uniform over what is actually available — a
   * re-roll would quietly over-weight whatever sits next to an owned work in
   * the canonical order.
   */
  catalogue: readonly EditionOffer[];
}

export interface EditionDraw {
  lat: number;
  lng: number;
  offer: EditionOffer;
  bearingDeg: number;
  distanceM: number;
}

const toDeg = (r: number) => (r * 180) / Math.PI;

/**
 * The whole draw, as one pure function of the seed.
 *
 * Given a revealed seed, the same origin, the same radii and the same
 * catalogue, anyone recomputes the same position and the same work. That is
 * the promise the commitment makes.
 */
export function deriveEdition(
  seed: string,
  params: EditionDrawParams,
): EditionDraw {
  const { origin, minRadiusM, maxRadiusM } = params;
  if (!(Number.isFinite(minRadiusM) && minRadiusM >= 0)) {
    throw new RangeError("minRadiusM must be a non-negative number");
  }
  if (!(Number.isFinite(maxRadiusM) && maxRadiusM >= minRadiusM)) {
    throw new RangeError("maxRadiusM must be >= minRadiusM");
  }

  const catalogue = canonicalOrder(params.catalogue);
  if (catalogue.length === 0) {
    // The caller decides whether this is "exhausted" or "unavailable"; it has
    // the context to tell those apart and this module does not. Refusing to
    // invent a work is the point.
    throw new RangeError("deriveEdition: catalogue is empty");
  }

  // A different label from every spawn draw, so the work chosen here cannot be
  // inferred from a spawn's bearing or amount under the same seed.
  const bearingRad =
    (Number(uniformBigInt(seed, "edition:bearing", 0n, 2n ** 32n - 1n)) /
      2 ** 32) *
    2 *
    Math.PI;

  // Area-uniform within the annulus, exactly as spawn.ts does it. Drawing the
  // radius linearly clusters drops near the inner edge, which over time
  // teaches players that walking the minimum distance is enough.
  const u =
    Number(uniformBigInt(seed, "edition:radius", 0n, 2n ** 32n - 1n)) / 2 ** 32;
  const distanceM = Math.sqrt(
    minRadiusM ** 2 + u * (maxRadiusM ** 2 - minRadiusM ** 2),
  );

  const index = Number(
    uniformBigInt(seed, "edition:work", 0n, BigInt(catalogue.length - 1)),
  );
  const offer = catalogue[index]!;

  const point = destinationPoint(origin, bearingRad, distanceM);
  return {
    lat: point.lat,
    lng: point.lng,
    offer,
    bearingDeg: toDeg(bearingRad),
    distanceM,
  };
}

// ---------------------------------------------------------------------------
// Quoting
// ---------------------------------------------------------------------------

/**
 * What the hunter will be charged, fixed at placement.
 *
 * The price is read from the venue when the drop is created and written onto
 * the row; it is NOT re-read when they arrive. A hunter who walks two minutes
 * toward a card that said 0.42 MON must be charged 0.42 MON.
 *
 * The cost of that promise is that the relayer absorbs any on-chain movement
 * inside the TTL, which is the correct party to absorb it — it is the one that
 * chose the TTL, and the hunter cannot see the venue at all. If the venue has
 * moved so far that the purchase fails, that is `price_moved`, and the honest
 * response is to re-place rather than to charge more than the card said.
 */
export function quotedPrice(offer: EditionOffer): bigint {
  if (offer.terms === "FREE") return 0n;
  if (offer.priceWei === null || offer.priceWei <= 0n) {
    // Mirrors the database CHECK. Reject by default: a PURCHASE without a
    // usable price must not reach a hunter as a free one.
    throw new RangeError(
      `quotedPrice: PURCHASE offer ${offer.collection}/${offer.masterId}/${offer.tier} has no positive price`,
    );
  }
  return offer.priceWei;
}

/**
 * Whether this hunter can afford the offer out of what they have not withdrawn.
 *
 * Deliberately `!(good)` rather than `if (bad)`, per AGENTS.md rule 2, so a NaN
 * or a negative balance lands on "cannot afford" instead of slipping through a
 * comparison.
 */
export function canAfford(
  unwithdrawnWei: bigint,
  priceWei: bigint,
): { ok: boolean; shortfallWei: bigint } {
  if (!(priceWei >= 0n)) throw new RangeError("canAfford: negative price");
  const ok = unwithdrawnWei >= priceWei;
  return { ok, shortfallWei: ok ? 0n : priceWei - unwithdrawnWei };
}

/**
 * What this hunter may actually be offered.
 *
 * Two filters, and the caller applies both before handing the catalogue to
 * `deriveEdition`: works their passkey already holds, and works they cannot
 * pay for. Filtering BEFORE the draw rather than re-rolling after it keeps the
 * draw uniform over what is available — a re-roll would quietly over-weight
 * whatever sits next to an excluded work in the canonical order.
 *
 * ## Why affordability is a placement filter and not only a card warning
 *
 * Measured with lib/hunt/edition.sim.test.ts. At the original 35-300 WMON
 * catalogue, filtering by affordability changed almost nothing: it converted
 * "a card you cannot tap" into "no card at all" and the wasted encounters
 * stayed wasted. Adding one 1 MON work flipped it — actionable encounters in
 * the first hour went from 17% to 33%. The filter is worth having once
 * something cheap exists; it was not before.
 *
 * It does NOT remove the need for the card to show a shortfall. An edition is
 * placed when affordable and walked to two minutes later, by which time the
 * hunter may have spent the money elsewhere. Placement is a courtesy; the card
 * is the correctness.
 *
 * `gasBufferWei` is why balance alone is not the test: the hunter signs the
 * payment themselves, so they need the price PLUS enough to send it. A wallet
 * holding exactly the price cannot pay it.
 */
export function placeableFor(
  catalogue: readonly EditionOffer[],
  held: ReadonlySet<string>,
  balanceWei: bigint,
  gasBufferWei: bigint,
): EditionOffer[] {
  return catalogue.filter((o) => {
    // Key must match EditionClaim's unique index, or a hunter is offered
    // something they already own — or barred from a tier they do not.
    if (held.has(`${o.collection}/${o.masterId}/${o.tier}`)) return false;
    // A FREE work costs the hunter nothing and needs no gas from them: the
    // relayer signs both transactions. So balance never excludes it, which is
    // what lets a hunter with zero MON still be given something.
    if (o.terms === "FREE") return true;
    return affordableWithGas(balanceWei, quotedPrice(o), gasBufferWei).ok;
  });
}

/** The key `placeableFor` expects in `held`, so callers cannot format it wrong. */
export function heldKey(offer: {
  collection: string;
  masterId: string;
  tier: EditionTier;
}): string {
  return `${offer.collection}/${offer.masterId}/${offer.tier}`;
}
