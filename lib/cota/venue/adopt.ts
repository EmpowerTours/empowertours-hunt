// Bringing the fill ledger back into agreement with the venue — and being exact
// about when that is safe.
//
// The ledger and the venue disagree whenever a fill lands after the socket that
// placed it has closed. Perpl accepts an order on the gateway and fills it on
// the chain a moment later, so this is not an edge case: it is what happens to
// every hunter's first fill (account 5273, 2026-09-14 — 214 MON open, ledger
// empty, every later order refused).
//
// aggregate.ts is right to fail closed on a mismatch, so the fix is not to
// loosen it. The fix is to record the missing fill. The question is at what
// price, and on whose say-so:
//
//   PRICE — derived from the venue's own `ep`, never a mark, never a guess. A
//   position with no `ep` cannot be adopted at all; it is reported as
//   unexplained and the caller keeps failing closed. Pricing an adoption at
//   anything but the venue's numbers would put a fabricated figure straight
//   into the daily-loss ceiling the hunter signed.
//
//   And `ep` is NOT the price to record. `ep` is the VWAP of the WHOLE position;
//   what is missing from the ledger is one fill inside it. Writing the delta at
//   `ep` is only correct when the ledger held nothing, which is why the first
//   adoption looked right and the second broke: account 5273 went 214 @ 0.023308
//   on the books, 345 @ ep 0.023159 at the venue, and the 131 adopted at `ep`
//   left the fold averaging 0.0232514 — 39.9 bps off the venue, past
//   aggregate.ts's 10 bps entry check, loss null, hunter blocked with no button
//   to press. Adoption and the entry-price reconcile were each right and jointly
//   broken. impliedMarginalUsd is the fix; see it for the arithmetic.
//
//   SAY-SO — a delta the agent's OWN pending order accounts for may be adopted
//   automatically: the agent authorised that order under the leash and watched
//   the venue accept it, so recording its fill is bookkeeping, not a new
//   decision. A delta nothing accounts for — size the hunter opened elsewhere,
//   a shared account — is NOT adopted automatically at any price. It surfaces
//   as unexplained, the caller refuses, and adopting it takes a deliberate act
//   by the hunter. Collapsing those two cases is the one mistake this module
//   exists to prevent: it would either block every hunter or silently swallow
//   trades the agent never made.

import type { MarkedMarket } from "./account-state";
import type { LedgerFill, OpenPos } from "./pnl";
import type { OpenPositionFrame } from "./frames";
import { signedSizeFromFrame } from "./aggregate";

/** Sizes are floats through descaling; below this the two sides agree. */
const EPS = 1e-6;

/**
 * How long an accepted-but-unfilled order stays able to explain a position.
 *
 * An order the venue acked and then never forwarded leaves a pending row that
 * nothing will ever resolve — which is not hypothetical: account 5273 has two,
 * from orders that carried a stale `rq`. A row like that must not sit around
 * indefinitely waiting to "explain" a position the hunter opens by hand a week
 * later, because that is exactly the silent adoption this module exists to
 * prevent. A fill that is going to land lands in seconds; half an hour is
 * generous and still bounded.
 */
export const PENDING_MAX_AGE_MS = 30 * 60 * 1000;

/** An order this agent placed and the venue accepted, still unaccounted for. */
export interface PendingOrder {
  id: string;
  marketId: number;
  /** +1 buy, -1 sell. */
  direction: 1 | -1;
  sizeUnits: number;
  orderId: number;
  placedAtMs: number;
}

export interface Unexplained {
  marketId: number;
  /** Signed size the venue holds that the ledger cannot account for. */
  deltaUnits: number;
  reason: "no_pending_order" | "no_entry_price" | "ledger_holds_more";
}

export interface AdoptionPlan {
  /** Synthetic fills to record, priced at the venue's own entry. */
  fills: LedgerFill[];
  /** Pending order ids fully accounted for by those fills. */
  resolvedOrderIds: string[];
  /** Deltas that must NOT be adopted without the hunter saying so. */
  unexplained: Unexplained[];
}

function deltaByMarket(
  fold: OpenPos[],
  venue: OpenPositionFrame[],
  marks: Map<number, MarkedMarket>,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const p of fold)
    out.set(p.marketId, (out.get(p.marketId) ?? 0) - p.signedSize);
  for (const v of venue) {
    out.set(
      v.marketId,
      (out.get(v.marketId) ?? 0) + signedSizeFromFrame(v, marks),
    );
  }
  return out;
}

/**
 * The price the missing fill must have had for the ledger to average out to the
 * venue's `ep`.
 *
 *     implied = (venueSize × venueEp − foldSize × foldEntry) / delta
 *
 * The venue's `ep` is the VWAP of everything open, so `venueSize × venueEp` is
 * what the whole position cost. Subtract what the ledger already accounts for
 * and the remainder is what the unrecorded fill cost; divide by its size for a
 * price. Record that, and the fold reproduces `ep` exactly — which is the
 * property aggregate.ts's entry-price check is testing for.
 *
 * With an empty ledger this reduces to `venueEp`, so a first adoption is
 * unchanged.
 *
 * It is a RECONSTRUCTION, not the fill price the venue charged. Both inputs
 * arrive rounded to price_decimals, so it lands a few units of the last decimal
 * off the truth: for 5273 this yields 0.0229156 where the venue's own traded
 * volume implies 0.0229130. Immaterial against a dollar-scale ceiling, and it
 * beats the alternative of a number that is wrong by 40 bps in a known
 * direction. It is not a substitute for recording the fill when we see it.
 *
 * Returns null when the arithmetic does not produce a usable price — a
 * non-finite result, or one at or below zero. That means the two sides disagree
 * about something more than a rounding step, and the caller must refuse rather
 * than write a nonsense entry and then believe it.
 */
export function impliedMarginalUsd(args: {
  venueSize: number;
  venueEntryUsd: number;
  foldSize: number;
  foldEntryUsd: number;
  delta: number;
}): number | null {
  const { venueSize, venueEntryUsd, foldSize, foldEntryUsd, delta } = args;
  if (delta === 0) return null;
  const implied = (venueSize * venueEntryUsd - foldSize * foldEntryUsd) / delta;
  if (!Number.isFinite(implied) || implied <= 0) return null;
  return implied;
}

/**
 * The share of a position's fees that is not on the books yet.
 *
 * The venue's `fee` on the position frame accumulates over the position's open
 * run, exactly as OpenPos.feesUsd does on our side (5273: 4440 after the first
 * fill, 7113 after the second). So what the missing fill cost in fees is the
 * difference, not the total.
 *
 * Clamped at zero, and that direction is deliberate. A negative remainder means
 * the ledger already holds at least the fees the venue says it charged — there
 * is nothing further to attribute, and the excess is already counted against the
 * day. Clamping cannot under-report the loss; it can only decline to add more.
 * That is the safe direction for a ceiling, and unlike a bad entry price an
 * over-counted fee does not corrupt the reconcile.
 */
export function remainingFeeUsd(
  positionFeeUsd: number,
  alreadyBookedUsd: number,
): number {
  if (!Number.isFinite(positionFeeUsd) || positionFeeUsd <= 0) return 0;
  if (!Number.isFinite(alreadyBookedUsd) || alreadyBookedUsd <= 0) {
    return positionFeeUsd;
  }
  return Math.max(0, positionFeeUsd - alreadyBookedUsd);
}

/**
 * What it would take to make the ledger agree with the venue.
 *
 * `trust: "pending"` (the automatic path) adopts only deltas a pending order of
 * the same market and direction covers. `trust: "hunter"` (the explicit path)
 * adopts any delta the venue prices, and is only ever reached from a deliberate
 * hunter action.
 *
 * A delta the ledger holds but the venue does not is never adopted either way.
 * That is a close or a liquidation, and the frame that would carry its price is
 * gone — there is nothing honest to record.
 */
export function planAdoption(args: {
  fold: OpenPos[];
  venue: OpenPositionFrame[];
  marks: Map<number, MarkedMarket>;
  pending: PendingOrder[];
  nowMs: number;
  trust: "pending" | "hunter";
}): AdoptionPlan {
  const { fold, venue, marks, pending, nowMs, trust } = args;
  const frames = new Map(venue.map((v) => [v.marketId, v]));
  const foldByMarket = new Map(fold.map((p) => [p.marketId, p]));
  const fills: LedgerFill[] = [];
  const resolvedOrderIds: string[] = [];
  const unexplained: Unexplained[] = [];

  for (const [marketId, delta] of deltaByMarket(fold, venue, marks)) {
    if (Math.abs(delta) <= EPS) continue;

    const frame = frames.get(marketId);
    if (!frame) {
      // The ledger holds size the venue does not: a close or liquidation whose
      // price left with the position. Never invent one.
      unexplained.push({
        marketId,
        deltaUnits: delta,
        reason: "ledger_holds_more",
      });
      continue;
    }
    if (frame.entryPriceScaled === null) {
      unexplained.push({
        marketId,
        deltaUnits: delta,
        reason: "no_entry_price",
      });
      continue;
    }

    const direction: 1 | -1 = delta > 0 ? 1 : -1;
    const mm = marks.get(marketId);
    if (!mm) throw new Error(`no market for held market ${marketId}`);

    const venueEntryUsd =
      frame.entryPriceScaled / 10 ** mm.market.priceDecimals;
    const held = foldByMarket.get(marketId);
    const priceUsd = impliedMarginalUsd({
      venueSize: signedSizeFromFrame(frame, marks),
      venueEntryUsd,
      foldSize: held?.signedSize ?? 0,
      foldEntryUsd: held?.entryUsd ?? 0,
      delta,
    });
    if (priceUsd === null) {
      // The two sides disagree by more than a rounding step. There is no honest
      // price to record, so this is the same answer as a frame with no `ep`:
      // refuse, and let the caller keep failing closed.
      unexplained.push({
        marketId,
        deltaUnits: delta,
        reason: "no_entry_price",
      });
      continue;
    }

    // Which of this agent's orders, if any, accounts for the delta.
    //
    // The AGE CAP applies only to the automatic path, and the difference is
    // authorisation versus attribution. Automatically adopting on the strength
    // of a stale row is the silent adoption this module exists to prevent, so
    // there it must be recent. On the hunter's explicit path the decision has
    // already been made by a person, and matching only decides which order to
    // WRITE THE FILL AGAINST — it authorises nothing, so an older row is fine.
    const candidate = (requireRecent: boolean) =>
      pending.find(
        (o) =>
          o.marketId === marketId &&
          o.direction === direction &&
          o.sizeUnits + EPS >= Math.abs(delta) &&
          o.placedAtMs <= nowMs &&
          (!requireRecent || nowMs - o.placedAtMs <= PENDING_MAX_AGE_MS),
      );

    let orderId = 0;
    if (trust === "pending") {
      const match = candidate(true);
      if (!match) {
        unexplained.push({
          marketId,
          deltaUnits: delta,
          reason: "no_pending_order",
        });
        continue;
      }
      orderId = match.orderId;
      resolvedOrderIds.push(match.id);
    } else {
      // Hunter path: adopt regardless, but attribute honestly when one of this
      // agent's own orders explains it. Leaving orderId 0 here made every
      // hunter adoption collapse to one id for the trades-per-day ceiling, and
      // left the order that actually filled sitting open forever — the same
      // fill counted twice, once as the pending row and once as the 0.
      const match = candidate(false);
      if (match) {
        orderId = match.orderId;
        resolvedOrderIds.push(match.id);
      }
    }

    fills.push({
      marketId,
      direction,
      sizeUnits: Math.abs(delta),
      priceUsd,
      // The fees the venue has charged this position MINUS what the ledger has
      // already booked against the run that is still open. See
      // remainingFeeUsd — attributing the whole figure every time was the same
      // whole-position-for-a-delta mistake the price had, and it compounded:
      // 5273 ended up claiming 0.011553 in fees against the venue's 0.007113.
      feeUsd: remainingFeeUsd(
        (frame.feeScaled ?? 0) / 1_000_000,
        held?.feesUsd ?? 0,
      ),
      timestampMs: nowMs,
      orderId,
    });
  }

  return { fills, resolvedOrderIds, unexplained };
}
