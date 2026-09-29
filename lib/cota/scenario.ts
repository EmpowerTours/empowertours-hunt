// What a position is worth at a price — arithmetic, not a forecast.
//
// WHY THIS EXISTS. The order form asks for a side, a size in dollars and a
// leverage, and showed no price at all. You could size $3 long at 2x with
// nothing on screen saying what MON costs, how many units that buys, or what a
// 5% move does to you. Every perp interface shows this and ours did not.
//
// THE DISTINCTION THAT MATTERS. Where the price GOES is unknowable and this
// module does not guess. Where your money ends up IF the price goes somewhere
// is division. Everything here is the second kind. Nothing in this file
// predicts, weights or ranks an outcome, and nothing should ever be added that
// does.
//
// THREE COSTS SIT BETWEEN A PRICE MOVE AND THE MONEY, and leaving any of them
// out flatters the number:
//
//   the spread on the way IN    — a long buys the ASK, not the mid
//   the spread on the way OUT   — and sells the BID
//   fees on both sides          — PER_SIDE_FEE_BPS, measured off real fills
//
// So a zero-move row is a LOSS here, by the round trip's width. That is the
// single most useful thing this table says, and the reason it leads with it.
//
// FEES ARE CHARGED ON BOTH SIDES even though the September close was charged
// nothing (see reference: fill 4 of the only real round trip, feeUsd 0). The
// venue's own config advertises `taker_fee: 345` in units that do not reconcile
// with the 6.9 bps measured on three real entry fills, so the measured number
// is used and it is applied twice. Both choices understate what you keep, which
// is the only safe direction for a number somebody sizes a position against.
//
// LEVERAGE CHANGES NOTHING ABOUT THE PRICE and everything about what the move
// means to you. It never touches gross or fees — only the margin those are
// divided by. At 2x a 5% move is 10% of your money, and that is the figure that
// hurts people, so it is the one shown large.

import { PER_SIDE_FEE_BPS } from "./exit";

/** The two sides of the book plus the venue's mark, as the context feed gives them. */
export interface Quote {
  /** The venue's own mark. Shown, never traded against — you cannot fill here. */
  markUsd: number;
  bidUsd: number;
  askUsd: number;
}

export interface Plan {
  side: "long" | "short";
  /** Position size in USD at entry. */
  notionalUsd: number;
  /** Only ever divides the margin. Must be > 0. */
  leverageX: number;
}

export interface Row {
  /** Move applied to the whole book, so the relative spread is preserved. */
  movePct: number;
  /** Where you would actually get out: the bid for a long, the ask for a short. */
  exitPriceUsd: number;
  /** Price move only, before any fee. */
  grossUsd: number;
  /** Both sides, at the measured rate. */
  feesUsd: number;
  /** What you keep. */
  netUsd: number;
  /** Net against YOUR money, not against the notional. */
  netPctOfMargin: number;
}

export interface Scenario {
  /** What you pay to get in: the ask for a long, the bid for a short. */
  entryPriceUsd: number;
  units: number;
  /** notional / leverage — the money actually at stake. */
  marginUsd: number;
  spreadBps: number;
  /** The round trip's cost at a flat price, as a positive number. */
  roundTripCostUsd: number;
  rows: Row[];
  /**
   * The move that gets you back to even. For a long it is positive and for a
   * short negative: you start down the spread and both fees, so the price has
   * to travel before you have made anything.
   */
  breakevenMovePct: number;
  /**
   * The move at which a close realises exactly the leash's daily-loss ceiling.
   *
   * This is deliberately here INSTEAD of a liquidation price. Perpl documents
   * `initial_margin` and `maintenance_margin` in contradictory units (see
   * app/api/cota/risk/route.ts) and the wrong reading errs toward telling
   * somebody they are safe. This number needs none of that: it is your own
   * signed ceiling, run through the same arithmetic as every other row.
   *
   * Null when no ceiling was given, or when it cannot be reached at all —
   * see leashStopUnreachable.
   */
  leashStopMovePct: number | null;
  leashStopPriceUsd: number | null;
  /**
   * True when the signed daily-loss ceiling CANNOT bind on this trade, because
   * the position would have to lose more than it can.
   *
   * This happens whenever the ceiling exceeds the worst case — a $5 cap on a $3
   * long needs the price below zero. It is worth saying out loud rather than
   * printing a move of −180%: it means the leash's loss limit is not what is
   * protecting you here. The size is.
   */
  leashStopUnreachable: boolean;
  /**
   * The most this can lose: a long's position taken to zero, fees included.
   *
   * Null for a SHORT, where it is genuinely unbounded — the price has no
   * ceiling, so neither does the loss. Null means unbounded and must never be
   * rendered as a number.
   */
  worstCaseUsd: number | null;
}

/** 8.9 bps as a fraction. */
const F = PER_SIDE_FEE_BPS / 10_000;

/** Moves the table shows, in percent. Symmetric, so neither direction is buried. */
export const DEFAULT_MOVES_PCT = [-10, -5, -2, 0, 2, 5, 10] as const;

function entryPriceFor(side: "long" | "short", q: Quote): number {
  return side === "long" ? q.askUsd : q.bidUsd;
}

/** The side of the book you LEAVE through, at a flat market. */
function exitPriceFor(side: "long" | "short", q: Quote): number {
  return side === "long" ? q.bidUsd : q.askUsd;
}

/**
 * Build the table, or null when any input makes the arithmetic meaningless.
 *
 * Null rather than zeroes: a table of zeroes reads as "this trade costs
 * nothing", which is the opposite of what a missing book means.
 */
export function scenario(
  plan: Plan,
  q: Quote,
  opts: { movesPct?: readonly number[]; maxDailyLossUsd?: number | null } = {},
): Scenario | null {
  const { side, notionalUsd, leverageX } = plan;
  if (!(notionalUsd > 0) || !(leverageX > 0)) return null;
  if (!(q.bidUsd > 0) || !(q.askUsd > 0) || q.askUsd < q.bidUsd) return null;

  const entryPriceUsd = entryPriceFor(side, q);
  const flatExit = exitPriceFor(side, q);
  const units = notionalUsd / entryPriceUsd;
  const marginUsd = notionalUsd / leverageX;
  const entryFeeUsd = notionalUsd * F;
  const mid = (q.bidUsd + q.askUsd) / 2;
  const spreadBps = ((q.askUsd - q.bidUsd) / mid) * 10_000;

  // Everything below prices an exit, so one function does the money and the
  // rows, the breakeven and the leash stop are all read off it.
  const netAtExit = (exitPriceUsd: number) => {
    const grossUsd =
      side === "long"
        ? units * (exitPriceUsd - entryPriceUsd)
        : units * (entryPriceUsd - exitPriceUsd);
    const exitFeeUsd = units * exitPriceUsd * F;
    const feesUsd = entryFeeUsd + exitFeeUsd;
    return { grossUsd, feesUsd, netUsd: grossUsd - feesUsd };
  };

  const moves = opts.movesPct ?? DEFAULT_MOVES_PCT;
  const rows: Row[] = moves.map((movePct) => {
    // The move is applied to the whole book, so the spread stays proportional
    // and no assumption is needed about how mark and mid drift apart (on this
    // venue they do: mark sits outside the book often enough to matter).
    const exitPriceUsd = flatExit * (1 + movePct / 100);
    const m = netAtExit(exitPriceUsd);
    return {
      movePct,
      exitPriceUsd,
      ...m,
      netPctOfMargin: (m.netUsd / marginUsd) * 100,
    };
  });

  // Closed forms, derived from netAtExit = target and solved for the exit
  // price. A test asserts each one round-trips back through netAtExit, so the
  // algebra cannot drift away from the function it claims to invert.
  //
  //   long : net = units·exit·(1−F) − N·(1+F)
  //   short: net = N·(1−F) − units·exit·(1+F)
  const exitForNet = (target: number) =>
    side === "long"
      ? (notionalUsd * (1 + F) + target) / (units * (1 - F))
      : (notionalUsd * (1 - F) - target) / (units * (1 + F));

  const moveToReach = (exitPriceUsd: number) =>
    (exitPriceUsd / flatExit - 1) * 100;

  // What a long loses if the price goes to zero: the whole notional, plus the
  // entry fee, and no exit fee because there is nothing left to charge one on.
  // A short has no such bound, and null here means exactly that.
  const worstCaseUsd = side === "long" ? -(notionalUsd * (1 + F)) : null;

  const loss = opts.maxDailyLossUsd;
  const hasStop = typeof loss === "number" && loss > 0;
  const rawStopExit = hasStop ? exitForNet(-loss) : null;
  // A long's exit price cannot be negative. When the algebra asks for one, the
  // ceiling is larger than the trade can ever lose and simply does not bind.
  const unreachable = rawStopExit !== null && rawStopExit <= 0;
  const stopExit = unreachable ? null : rawStopExit;

  return {
    entryPriceUsd,
    units,
    marginUsd,
    spreadBps,
    roundTripCostUsd: -netAtExit(flatExit).netUsd,
    rows,
    breakevenMovePct: moveToReach(exitForNet(0)),
    leashStopMovePct: stopExit === null ? null : moveToReach(stopExit),
    leashStopPriceUsd: stopExit,
    leashStopUnreachable: unreachable,
    worstCaseUsd,
  };
}
