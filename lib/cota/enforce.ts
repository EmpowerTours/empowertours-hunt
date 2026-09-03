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
  | "daily_loss_reached";

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

/** Human-readable reason, for the screen a player is actually looking at. */
export function explainDenial(reason: DenyReason): string {
  switch (reason) {
    case "revoked":
      return "You revoked this Cota. Sign a new one to trade again.";
    case "not_yet_valid":
      return "This Cota hasn't started yet.";
    case "expired":
      return "This Cota has expired. Sign a new one to keep going.";
    case "wrong_venue":
      return "This Cota doesn't authorise that venue.";
    case "market_not_authorised":
      return "This Cota doesn't name that market.";
    case "notional_exceeded":
      return "That order would push your total position past the size you set.";
    case "leverage_exceeded":
      return "That order asks for more leverage than you allowed.";
    case "trade_count_exceeded":
      return "You've used every trade this Cota allows today.";
    case "daily_loss_reached":
      return "Today's loss limit is reached. Trading stops until tomorrow.";
  }
}
