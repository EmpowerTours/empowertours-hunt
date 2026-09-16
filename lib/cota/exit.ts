// When the agent gets out — a function, not a model.
//
// Kimi proposes ENTRIES. The exit is mechanical on purpose: a take-profit an LLM
// re-argues every five minutes is not a take-profit, and the one decision that
// must be reproducible after the fact is the one that realises money.
//
// ## It never closes at a loss. That is the instruction.
//
// The agent closes in profit or it holds. There is no stop. The consequence is
// real and was accepted deliberately: a position that goes against the agent is
// held indefinitely, and what bounds the damage is the notional ceiling (it
// cannot add past it), the daily-loss stop (which halts OPENING), and in the
// last resort the venue's own liquidation. Anyone reading this later should know
// that was chosen, not overlooked.
//
// ## "Not at a loss" means NET, and that is the hard part
//
// A position showing a gain against the mark can still realise a loss, because
// three costs sit between the mark and the money:
//
//   fees already paid on the position   — the venue's `fee` field
//   the fee to close                    — 8.9 bps (6.9 taker + 2.0 builder),
//                                         confirmed against real fills on 5273:
//                                         0.004440 on notional 4.988214
//   the spread crossed on the way out   — a long closes at the BID, not the mid
//
// The third is why this takes an exitPriceUsd rather than a mark. Modelling the
// exit at the mid quietly overstates every close by half the spread, which on
// MON was 24.2 bps — bigger than the fees. Passing the price the order would
// actually fill at removes the fudge instead of approximating it: bid for a
// long, ask for a short.

/** Fee charged per side, in bps of notional. Taker 6.9 + builder 2.0. */
export const PER_SIDE_FEE_BPS = 8.9;

export interface ExitPolicy {
  /**
   * Close at or above this NET gain, in bps of the notional being closed.
   *
   * Net of everything, so this is money kept, not a price move. The default of
   * 100 bps is deliberately not tuned — nothing in this system has measured an
   * edge, and a threshold that looks precise would imply one. It is a round
   * number comfortably clear of the ~18 bps of round-trip fees, chosen so that a
   * "win" is worth the two transactions it took.
   */
  takeProfitBps: number;
}

export const DEFAULT_EXIT_POLICY: ExitPolicy = { takeProfitBps: 100 };

export interface PositionSnapshot {
  /** Signed size: > 0 long, < 0 short. */
  signedSize: number;
  /** Entry price in USD — the venue's `ep` PLUS its `epr` residue. */
  entryUsd: number;
  /**
   * The price a close would actually fill at: the BID for a long, the ASK for a
   * short. Not the mark, and not the mid. See the note above.
   */
  exitPriceUsd: number;
  /** Fees already charged on this position, USD. The venue's `fee` field. */
  feesPaidUsd: number;
}

export interface ExitMath {
  /** Notional being closed, at the exit price. */
  notionalUsd: number;
  /** Price move only, at the exit price, before any fee. */
  grossUsd: number;
  /** What closing costs in fees. */
  exitFeeUsd: number;
  /** grossUsd − fees already paid − the fee to close. The money kept. */
  netUsd: number;
  /** netUsd as bps of the notional being closed. */
  netBps: number;
}

export type ExitDecision =
  | { act: "hold"; math: ExitMath; why: "not_profitable_enough" | "flat" }
  | { act: "close"; reason: "take_profit"; math: ExitMath };

/** What a close would actually realise, after every cost. */
export function exitMath(p: PositionSnapshot): ExitMath {
  const notionalUsd = Math.abs(p.signedSize) * p.exitPriceUsd;
  const grossUsd = p.signedSize * (p.exitPriceUsd - p.entryUsd);
  const exitFeeUsd = (notionalUsd * PER_SIDE_FEE_BPS) / 10_000;
  const netUsd = grossUsd - p.feesPaidUsd - exitFeeUsd;
  return {
    notionalUsd,
    grossUsd,
    exitFeeUsd,
    netUsd,
    netBps: notionalUsd === 0 ? 0 : (netUsd / notionalUsd) * 10_000,
  };
}

/**
 * Should the agent close now?
 *
 * Closes only on a net gain at or above the threshold. Everything else holds,
 * including a position that is net down — by instruction.
 *
 * A flat position holds too: returning "close" for nothing would have the caller
 * send a zero-size order the venue refuses.
 */
export function shouldExit(
  p: PositionSnapshot,
  policy: ExitPolicy = DEFAULT_EXIT_POLICY,
): ExitDecision {
  const math = exitMath(p);
  if (p.signedSize === 0) return { act: "hold", math, why: "flat" };
  if (math.netBps >= policy.takeProfitBps && math.netUsd > 0) {
    return { act: "close", reason: "take_profit", math };
  }
  return { act: "hold", math, why: "not_profitable_enough" };
}
