// Assemble the DayState inputs from two sources of truth, and refuse to trust a
// loss number we can't vouch for.
//
// Open notional comes from the VENUE's position snapshot — authoritative on
// current size, and it reflects a liquidation we may have no close-fill for.
// Loss comes from OUR fill ledger (fills-VWAP; the venue sends no PnL). Those
// only agree when the ledger is complete: if the venue holds size we have no
// fills for — a manual trade on a shared account, or size we mis-tracked — the
// ledger's loss is wrong, and the only safe answer is null (fail closed), never
// a number that silently under-reports the day's drawdown.

import {
  openNotionalUsdE6,
  type AggregateState,
  type MarkedMarket,
} from "./account-state";
import {
  foldFills,
  lossTodayUsdE6,
  countOrdersToday,
  type LedgerFill,
  type OpenPos,
} from "./pnl";
import type { OpenPositionFrame } from "./frames";

// Positions are floats through descaling; anything under this is "the same size".
const RECON_EPS = 1e-6;

/** Signed size in units from a venue frame (side 2 = short → negative). */
export function signedSizeFromFrame(
  f: OpenPositionFrame,
  marks: Map<number, MarkedMarket>,
): number {
  const mm = marks.get(f.marketId);
  if (!mm) {
    throw new Error(`no market for held market ${f.marketId}`);
  }
  const units = f.sizeScaled / 10 ** mm.market.sizeDecimals;
  return f.side === 2 ? -units : units; // SD_SHORT
}

/**
 * Does our fills-derived position set match the venue's, market by market? A
 * mismatch means the ledger is incomplete and its loss can't be trusted.
 */
export function positionsReconcile(
  fold: OpenPos[],
  venue: OpenPositionFrame[],
  marks: Map<number, MarkedMarket>,
): boolean {
  const foldByMkt = new Map(fold.map((p) => [p.marketId, p.signedSize]));
  const venueByMkt = new Map(
    venue.map((v) => [v.marketId, signedSizeFromFrame(v, marks)]),
  );
  const markets = new Set([...foldByMkt.keys(), ...venueByMkt.keys()]);
  for (const m of markets) {
    const a = foldByMkt.get(m) ?? 0;
    const b = venueByMkt.get(m) ?? 0;
    if (Math.abs(a - b) > RECON_EPS) return false;
  }
  return true;
}

/**
 * Build the AggregateState the leash is checked against. Open notional and
 * trades-today are always real; loss is the fills fold ONLY when it reconciles
 * with the venue snapshot, else null so the caller fails closed.
 */
export function buildAggregateState(args: {
  fills: LedgerFill[];
  venuePositions: OpenPositionFrame[];
  marks: Map<number, MarkedMarket>;
  nowMs: number;
}): AggregateState {
  const { fills, venuePositions, marks, nowMs } = args;
  const { positions } = foldFills(fills);
  const reconciled = positionsReconcile(positions, venuePositions, marks);
  return {
    openNotionalUsdE6: openNotionalUsdE6(venuePositions, marks),
    tradesToday: countOrdersToday(fills, nowMs),
    lossTodayUsdE6: reconciled ? lossTodayUsdE6(fills, marks, nowMs) : null,
  };
}
