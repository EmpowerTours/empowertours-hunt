// Where to rest a post-only order, and when not to bother.
//
// Perpl charges 6.9 bps to take and 0.9 bps to make. Resting instead of crossing
// is a 7.7x cut in the fee on that side, and on a leash whose whole take-profit
// threshold exists to clear ~42 bps of friction that is not a rounding
// improvement — it is most of the friction.
//
// ## Why only OPENS rest, and closes still cross
//
// A resting order may never fill. When the agent is opening, not filling is the
// state it was already in: it is flat, it stays flat, and the next tick asks
// again. Nothing is lost but a block of patience.
//
// When it is CLOSING, not filling means sitting in a position it has already
// decided to be out of, while the price that made the exit profitable moves
// away. The take-profit threshold is net of taker fees precisely so that
// crossing is affordable at the moment it fires. Paying 6 bps to actually get
// out is the trade this system wants; saving 6 bps and maybe not getting out is
// not.
//
// So: patient on the way in, decisive on the way out. It is not symmetric
// because the cost of not filling is not symmetric.

import type { Market } from "./order";

export interface Touch {
  bidUsd: number | null;
  askUsd: number | null;
}

export interface PostOnlyQuote {
  /** Limit price to rest at, in USD. */
  priceUsd: number;
  /** How far inside the touch it sits, in ticks. 0 means joining the touch. */
  insideTicks: number;
}

/**
 * The price to rest a post-only order at, or null when resting is wrong here.
 *
 * Rests one tick INSIDE the touch when the spread is wide enough to allow it,
 * which gets priority over everything already resting at the touch without
 * crossing. When the spread is one tick or less there is no inside to move to,
 * so it joins the touch instead — moving further would cross, and a post-only
 * order that would cross is rejected by the venue rather than filled, which is
 * the correct behaviour and a wasted request.
 *
 * Returns null when the relevant side is missing. A book with no bid cannot tell
 * us where a buy should rest, and guessing from the mark would put the order
 * somewhere the market is not.
 */
export function postOnlyPrice(
  market: Market,
  side: "long" | "short",
  touch: Touch,
): PostOnlyQuote | null {
  const tick = 1 / 10 ** market.priceDecimals;
  const { bidUsd, askUsd } = touch;

  // A buy rests on the bid side, a sell on the ask side.
  const own = side === "long" ? bidUsd : askUsd;
  const other = side === "long" ? askUsd : bidUsd;
  if (own === null || own <= 0) return null;

  // With no other side we can still rest at our own touch — we just cannot know
  // whether there is room to improve, so we do not try.
  if (other === null || other <= 0) {
    return { priceUsd: own, insideTicks: 0 };
  }

  const spread = side === "long" ? other - own : own - other;
  // One tick or less of spread: there is no room inside, so join the touch.
  if (spread <= tick * 1.5) return { priceUsd: own, insideTicks: 0 };

  const improved = side === "long" ? own + tick : own - tick;
  // Round to the venue's grid so the price is one the book can hold.
  const scaled = Math.round(improved * 10 ** market.priceDecimals);
  return { priceUsd: scaled / 10 ** market.priceDecimals, insideTicks: 1 };
}
