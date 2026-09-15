// ---------------------------------------------------------------------------
// What a signed Cota actually permits, evaluated against the state of the day.
//
// This module is the product. Everything else around a Cota — the passkey, the
// EIP-712 machinery, the anchoring — establishes that the player really did
// agree to these numbers. Only this file decides whether the next order is
// inside them, and it is the file that has to be right when the other side can
// lose money faster than a person can watch it.
//
// ## It does not know whether execution is real
//
// There is no `simulated` flag anywhere below, and that is deliberate. A paper
// mode whose limits live inside the simulator proves nothing about the live
// path, because going live means rewriting the checks — and the rewrite is
// exactly where the bug goes. Both executors call these same two functions, so
// a Hunt player trading on paper is exercising the code that will one day hold
// somebody's real collateral. That is the only sense in which practice is
// worth anything.
//
// ## Pure by construction
//
// No clock, no database, no network. `now` is a parameter because a limit that
// reads the wall clock cannot be tested at a boundary, and every interesting
// case here IS a boundary.
// ---------------------------------------------------------------------------

import { denialTextEn } from "./denial-text";

/**
 * Why an order was refused, or why an open position must be closed.
 *
 * A closed union rather than a string: a caller that invents its own reason
 * produces an audit trail nobody can group, and these strings end up in front
 * of a player asking why their agent stopped.
 */
export type DenyReason =
  | "revoked"
  | "not_yet_valid"
  | "expired"
  | "wrong_venue"
  | "market_not_authorised"
  | "notional_exceeded"
  | "leverage_exceeded"
  | "trade_count_exceeded"
  | "daily_loss_reached"
  // Reduce-only reasons. They describe the POSITION, not the leash, because a
  // reduce is not gated on the leash — see mayReduce.
  | "nothing_to_reduce"
  | "reduce_exceeds_position";

export type Decision = { ok: true } | { ok: false; reason: DenyReason };

const ALLOW: Decision = { ok: true };

function deny(reason: DenyReason): Decision {
  return { ok: false, reason };
}

/**
 * The bound as signed, after verification, in the units it was signed in.
 *
 * Scaled integers throughout. These numbers are COMPARED, and a float compare
 * against a ceiling somebody agreed to is how a limit silently becomes
 * approximate — see lib/cota/scale.ts.
 */
export interface EnforcedBound {
  venue: string;
  markets: readonly string[];
  maxNotionalUsdE6: bigint;
  maxLeverageX100: bigint;
  maxDailyLossUsdE6: bigint;
  maxTradesPerDay: number;
  /** Unix seconds, as signed. */
  notBefore: bigint;
  notAfter: bigint;
  /** Set when the player revoked early; null while the bound still stands. */
  revokedAt: Date | null;
}

/**
 * Everything about the current UTC day that a ceiling is measured against.
 *
 * ## Why the day is UTC and not a rolling 24 hours
 *
 * "Three trades per day" and "three trades in any 24 hours" are different
 * promises, and the difference is not cosmetic: a rolling window never resets,
 * so a player who hit their limit at 23:00 is still blocked at 09:00 the next
 * morning and reasonably believes the software is broken. A UTC day resets at
 * a moment both sides can name. Caller computes the boundary; this file only
 * compares.
 */
export interface DayState {
  /** Orders already placed inside the current UTC day. */
  tradesToday: number;

  /**
   * Loss so far today, positive meaning down. Realised AND unrealised.
   *
   * Counting only realised loss would leave the ceiling trivially escapable:
   * a position sitting at minus four hundred dollars has lost the money
   * whether or not anybody has pressed close, and an agent that never closes
   * a loser would never register a loss at all. That is the exact failure the
   * daily-loss number exists to prevent.
   */
  lossTodayUsdE6: bigint;

  /**
   * Notional currently open, before the proposed order.
   *
   * Needed because the notional ceiling is aggregate, not per-order — see
   * {@link mayOpen}.
   */
  openNotionalUsdE6: bigint;
}

/** A proposed order, in the same units the bound was signed in. */
export interface ProposedOrder {
  venue: string;
  market: string;
  notionalUsdE6: bigint;
  leverageX100: bigint;
}

/**
 * Checks that apply whether or not an order is being placed.
 *
 * Shared by both entry points so that "the bound has expired" cannot be true
 * for one and false for the other. Returns null when the bound is live.
 */
function boundIsLive(
  bound: EnforcedBound,
  nowSeconds: bigint,
): DenyReason | null {
  // Revocation first. A player who has revoked has withdrawn consent, and no
  // amount of remaining budget or unexpired window reinstates it.
  if (bound.revokedAt !== null) return "revoked";
  if (nowSeconds < bound.notBefore) return "not_yet_valid";
  if (nowSeconds > bound.notAfter) return "expired";
  return null;
}

/**
 * May this order be placed?
 *
 * ## The notional ceiling is aggregate, and that is the whole point
 *
 * Read as a per-order cap, `maxNotionalUsdE6` is defeated by arithmetic: a
 * bound of $200 permits two orders of $200 and then a third, and the player
 * who wrote "200" is carrying $600. So the ceiling is measured against total
 * open notional including the order being proposed. A limit that splitting
 * defeats is decoration.
 *
 * ## Order of checks
 *
 * Liveness, then authority (venue, market), then the numbers. A player whose
 * bound expired should be told that, rather than being told their leverage is
 * too high on a bound that authorises nothing at all.
 */
export function mayOpen(
  bound: EnforcedBound,
  state: DayState,
  order: ProposedOrder,
  nowSeconds: bigint,
): Decision {
  const dead = boundIsLive(bound, nowSeconds);
  if (dead !== null) return deny(dead);

  if (order.venue !== bound.venue) return deny("wrong_venue");

  // Empty markets is a real state, not a malformed one: a signed Cota naming
  // no market is a revocation the player can prove they made. It authorises
  // nothing, and falls out of this check without a special case.
  if (!bound.markets.includes(order.market)) {
    return deny("market_not_authorised");
  }

  // Loss ceiling before trade count, because reaching it is the more serious
  // condition and the one the player most needs named. Note `>=`: a bound that
  // has spent its entire loss budget is finished, not one order short.
  if (state.lossTodayUsdE6 >= bound.maxDailyLossUsdE6) {
    return deny("daily_loss_reached");
  }

  if (state.tradesToday >= bound.maxTradesPerDay) {
    return deny("trade_count_exceeded");
  }

  if (order.leverageX100 > bound.maxLeverageX100) {
    return deny("leverage_exceeded");
  }

  if (state.openNotionalUsdE6 + order.notionalUsdE6 > bound.maxNotionalUsdE6) {
    return deny("notional_exceeded");
  }

  return ALLOW;
}

/**
 * Must trading stop right now, regardless of what anybody is proposing?
 *
 * ## This does NOT mean flatten
 *
 * It was called `mustClose` and told the runner to close the book. That was
 * the wrong instruction: `position_loop` in the trading agent is built around
 * the opposite rule — it cannot close at a loss — and forcing a close is
 * exactly how a daily-loss ceiling turns into a realised loss the player never
 * asked to take.
 *
 * So a halt stops NEW risk. No opening, no increasing. Reducing and closing
 * stay permitted always, because software that could not reduce risk once a
 * limit was breached would be the opposite of a safety mechanism.
 *
 * ## Which means the ceiling bounds new risk, not total loss
 *
 * Worth being blunt about, because it is the honest reading and the read-back
 * says so: a position left open can keep moving against the player after the
 * halt. What the number guarantees is that nothing NEW is put at risk once it
 * is reached — not that losses stop accruing.
 *
 * Still has to be polled. A position can cross the ceiling with nobody placing
 * an order at all, and a bound consulted only at order time would not notice
 * until the next one.
 */
export function mustHalt(
  bound: EnforcedBound,
  state: DayState,
  nowSeconds: bigint,
): Decision {
  const dead = boundIsLive(bound, nowSeconds);
  if (dead !== null) return deny(dead);

  if (state.lossTodayUsdE6 >= bound.maxDailyLossUsdE6) {
    return deny("daily_loss_reached");
  }

  return ALLOW;
}

/**
 * The UTC day a moment belongs to, as `YYYY-MM-DD`.
 *
 * One place, so that the writer recording a trade and the reader counting
 * today's trades cannot disagree about which day it is. A mismatch here would
 * hand a player back their whole daily budget at the wrong hour, which is the
 * kind of bug that only shows up in one timezone.
 */
export function utcDayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Human-readable reason, for the screen a player is actually looking at.
 * English only — the bilingual table lives in ./denial-text, which the browser
 * reads directly. Keeping one table means the two can never drift apart.
 */
export function explainDenial(reason: DenyReason): string {
  return denialTextEn(reason);
}

/** Sizes descale through floats; below this a position is flat. */
const REDUCE_EPS = 1e-9;

/** What the venue reports open on one market, signed: > 0 long, < 0 short. */
export interface OpenSize {
  market: string;
  signedSize: number;
}

/**
 * May this reduce go to the venue?
 *
 * ## It is deliberately NOT gated on the leash
 *
 * Every other check in this file exists to bound what the agent may do to a
 * hunter's account. This one is the opposite case, and mustHalt already says so
 * in words: "Reducing and closing stay permitted always, because software that
 * could not reduce risk once a limit was breached would be the opposite of a
 * safety mechanism." Until now that sentence described behaviour no code
 * implemented.
 *
 * So there is no notional ceiling here, no leverage check, no daily-loss stop,
 * no trades-per-day count, and no expiry or revocation check. Every one of them,
 * applied to a reduce, converts a safety limit into a trap: the hunter who most
 * needs to cut risk is exactly the hunter who has hit their ceiling, spent their
 * trades, or let their Cota lapse. A leash that locks someone into a position
 * is worse than no leash, because they took the position believing they could
 * get out.
 *
 * The authorisation for a reduce comes from the hunter being signed in and
 * asking, not from the Cota. The Cota bounds the agent; this is the person.
 *
 * What is left is arithmetic, and it is the part that actually matters: you
 * cannot reduce a position you do not hold, and you cannot reduce by more than
 * you hold. Closing more than the open size is a FLIP — it opens new exposure on
 * the other side — and new exposure belongs back under mayOpen where the
 * ceilings apply. That boundary is the whole reason this function is strict
 * about size while being permissive about everything else.
 */
export function mayReduce(open: OpenSize, requestedUnits: number): Decision {
  const held = Math.abs(open.signedSize);
  if (held <= REDUCE_EPS) return deny("nothing_to_reduce");
  if (requestedUnits <= REDUCE_EPS) return deny("nothing_to_reduce");
  // Strictly greater: closing exactly the open size is a full close, which is
  // the most common reduce there is and must not be mistaken for a flip.
  if (requestedUnits > held + REDUCE_EPS)
    return deny("reduce_exceeds_position");
  return ALLOW;
}
