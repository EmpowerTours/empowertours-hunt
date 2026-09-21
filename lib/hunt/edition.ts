// The edition mechanic — a chance ENCOUNTER with an fcempowertours work.
//
// Not a spawn, and not a place. A card appears over the scope — "you bumped
// into an artist selling their music" — and the hunter answers yes or no from
// wherever they are standing. Nobody walks to it.
//
// WHY NONE OF SPAWN'S ANTI-SPOOFING IS HERE
//
// Spawns check GPS accuracy, clock skew, plausible speed and proximity
// because a spawn pays the TREASURY's money for reaching a place: faking a
// position steals. An edition takes the HUNTER's money. A spoofer who fakes
// their way into an encounter has bought something. So those checks are
// absent by reasoning, not by omission — copying them across would have been
// cargo cult, and would have made an offer harder to accept than a payout is
// to claim.
//
// WHAT IS STILL PURE AND WHY
//
// The decision logic takes no DB, no network and no clock, so a dispute is
// answered by replaying stored rows rather than by anyone's recollection —
// the same reason lib/hunt/spawn.ts and lib/hunt/validator.ts are written
// this way.

import { uniformBigInt } from "@/lib/hunt/spawn";
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
  "edition_cooldown",
  // They have only just arrived. Distinct from the cooldown because it is a
  // different clock with a different cause: the cooldown says "not so soon
  // after the last one", this says "not the second you open the app".
  "edition_warmup",
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
  "edition_not_found",
  "edition_expired",
  "edition_already_taken",
  // They said no. Kept distinct from expiry so the UI can tell "you declined"
  // from "it timed out" rather than guessing.
  "edition_dismissed",
  // The passkey already holds this work at this tier. Enforced by the unique
  // index on EditionClaim, so this is what that violation is rendered as.
  "already_owned",
  // Their wallet cannot cover price + gas. Named for the wallet, not for
  // "earnings": payouts land in the hunter's own wallet and there is no
  // internal balance to run short of.
  "insufficient_funds",
  // The venue would not sell at the quoted price. Distinct because it is
  // nobody's fault and is fixed by re-offering, not by the hunter acting.
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
  /**
   * What this player may be offered: the catalogue MINUS everything their
   * passkey already holds and everything they cannot pay for. Filtering
   * BEFORE the draw rather than re-rolling after it keeps the draw uniform
   * over what is actually available — a re-roll would quietly over-weight
   * whatever sits next to an excluded work in the canonical order.
   */
  catalogue: readonly EditionOffer[];
}

export interface EditionDraw {
  offer: EditionOffer;
}

/**
 * Which work they bumped into, as one pure function of the seed.
 *
 * Deterministic so the choice can be replayed when somebody asks why they
 * were offered a particular record. It is NOT a fairness commitment the way a
 * spawn's seed is: a spawn's seed fixes an AMOUNT that the treasury would
 * otherwise be free to choose after the fact, whereas an edition's price is
 * the venue's public number and the catalogue is public too. There is nothing
 * here to cheat, so there is no commit-reveal — and no seedCommit column.
 */
export function deriveEdition(
  seed: string,
  params: EditionDrawParams,
): EditionDraw {
  const catalogue = canonicalOrder(params.catalogue);
  if (catalogue.length === 0) {
    // The caller decides whether this is "exhausted" or "unavailable"; it has
    // the context to tell those apart and this module does not. Refusing to
    // invent a work is the point.
    throw new RangeError("deriveEdition: catalogue is empty");
  }
  const index = Number(
    uniformBigInt(seed, "edition:work", 0n, BigInt(catalogue.length - 1)),
  );
  return { offer: catalogue[index]! };
}

/**
 * The offers this player has seen least recently, and nothing else.
 *
 * ## Why the draw alone was not enough
 *
 * `deriveEdition` is uniform over whatever it is handed, and that is correct.
 * The problem is what it was being handed. Affordability and relayer capacity
 * cut a twelve-offer catalogue down to two or three for a real wallet — on the
 * live hunt on 2026-09-21 a 95 MON hunter could reach exactly three of them,
 * already held one, and so every encounter was a coin flip between the same
 * two works. Three of the four editions ever placed were master 8, MARINA,
 * twice declined and offered again anyway.
 *
 * Uniform over two is not a bug in the draw. It is the wrong question: a
 * catalogue this small wants a ROTATION, not a shuffle.
 *
 * ## Why last-offered and not last-declined
 *
 * `Edition.dismissedAt` already carries the schema's intent — "declining is an
 * answer, and re-asking would read as nagging" — and nothing read it. But
 * keying on declines alone would still re-offer a work that timed out unseen
 * in the hunter's pocket, which reads identically from the outside. Having
 * been PLACED is the fact that matters; how it ended is not.
 *
 * ## Why it narrows instead of excluding
 *
 * Excluding everything recently offered empties the list, and an empty list is
 * `catalogue_exhausted` — a hunter with two affordable works would be told
 * there is nothing rather than shown the older of the two. Narrowing to the
 * oldest tier always returns at least one offer when given at least one, so
 * rotation degrades to strict alternation at two works and to "never twice
 * running" at three, instead of degrading to silence.
 *
 * Ties are left in the returned array on purpose: the seed breaks them, so
 * with a wide catalogue of never-seen works the draw is still uniform.
 */
export function leastRecentlyOffered(
  placeable: readonly EditionOffer[],
  /** heldKey -> epoch ms this player was last OFFERED it, in any hunt. */
  lastOfferedAt: ReadonlyMap<string, number>,
): EditionOffer[] {
  if (placeable.length === 0) return [];
  // Never offered sorts before every timestamp, which is what makes a fresh
  // work always beat a repeat rather than merely being likelier than one.
  const at = (o: EditionOffer): number =>
    lastOfferedAt.get(heldKey(o)) ?? Number.NEGATIVE_INFINITY;
  let best = Number.POSITIVE_INFINITY;
  for (const o of placeable) {
    const t = at(o);
    if (t < best) best = t;
  }
  return placeable.filter((o) => at(o) === best);
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

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export interface EditionEligibilityContext {
  serverNow: Date;
  playerActive: boolean;
  huntActive: boolean;
  editionsEnabled: boolean;
  /** When this player was last offered an edition in this hunt. */
  lastEditionAt: Date | null;
  editionCooldownSeconds: number;
  /**
   * Not before this instant may this player be offered anything — the
   * session warm-up, from `PlayerHunt.editionsOpenAt`.
   *
   * The caller passes `serverNow` when there is no row rather than null, so
   * "we have never seen this player in this hunt" denies rather than allows.
   * Null is kept representable only for hunts that do not want a warm-up at
   * all, which is what `editionFirstDelaySeconds = 0` produces.
   */
  editionsOpenAt: Date | null;
  /** One live card at a time. Spawns are counted separately, on purpose. */
  hasActiveEdition: boolean;
  /** How many works they could actually be offered right now. */
  placeableCount: number;
  /** True when the catalogue could not be read at all. */
  catalogueUnavailable: boolean;
}

export type EditionEligibility =
  { ok: true } | { ok: false; reason: EditionDenyReason };

/**
 * May this player be offered an edition right now?
 *
 * INDEPENDENT OF SPAWNS, deliberately. A hunter may be walking toward money
 * and be offered a record at the same time: they are different products with
 * different cadences, and making one block the other would mean every
 * encounter costs a spawn — turning a 1 MON purchase into a 2 MON one without
 * saying so.
 *
 * NO POSITION IS REQUIRED. An edition is not placed anywhere, so there is no
 * origin to anchor and nothing a spoofed position could win: the hunter is
 * being asked to SPEND. Requiring a fresh verified fix would only mean an
 * offer is harder to receive than a payout is to claim.
 *
 * Reject by default, in the order that gives the most useful answer.
 * `catalogue_exhausted` and `catalogue_unavailable` stay distinct to the end,
 * because "you own everything" and "we could not ask" are different facts and
 * only one of them is the player's business.
 */
export function evaluateEditionEligibility(
  ctx: EditionEligibilityContext,
): EditionEligibility {
  if (!ctx.editionsEnabled) return { ok: false, reason: "editions_disabled" };
  if (!ctx.playerActive) return { ok: false, reason: "player_not_active" };
  if (!ctx.huntActive) return { ok: false, reason: "hunt_not_active" };

  if (ctx.hasActiveEdition) {
    return { ok: false, reason: "edition_already_active" };
  }

  // The warm-up first, because it is the one that is true on arrival and the
  // cooldown is silent then. Checked with `!(now >= open)` rather than
  // `now < open` so an Invalid Date lands on "not yet" — AGENTS.md rule 2.
  if (ctx.editionsOpenAt !== null) {
    if (!(ctx.serverNow.getTime() >= ctx.editionsOpenAt.getTime())) {
      return { ok: false, reason: "edition_warmup" };
    }
  }

  if (ctx.lastEditionAt !== null) {
    const sinceS =
      (ctx.serverNow.getTime() - ctx.lastEditionAt.getTime()) / 1000;
    if (!(sinceS >= ctx.editionCooldownSeconds)) {
      return { ok: false, reason: "edition_cooldown" };
    }
  }

  // Unavailable before exhausted: a failed read must never be reported to a
  // player as "you already own everything".
  if (ctx.catalogueUnavailable) {
    return { ok: false, reason: "catalogue_unavailable" };
  }
  if (ctx.placeableCount <= 0) {
    return { ok: false, reason: "catalogue_exhausted" };
  }

  return { ok: true };
}
