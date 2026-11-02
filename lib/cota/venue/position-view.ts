// ---------------------------------------------------------------------------
// The hunter's open Perpl positions, in words a screen and a log can show.
//
// The server reads these on every trade (readDayState) and used to throw them
// away. On 2026-10-31 three one-click orders against $26.00 available came back
// TakerOrderSettlementFailed, and the only way to see whether a position was
// already holding margin was to go to app.perpl.xyz. Cota holds the key that
// reads this; it should say it.
// ---------------------------------------------------------------------------

import type { OpenPositionFrame } from "./frames";
import { EXECUTABLE_MARKETS, type Market } from "../order";

export interface PositionView {
  pid: number;
  /** "MON", or "#<id>" for a market this app does not pin. */
  market: string;
  side: "long" | "short" | "unknown";
  /** Descaled when the market is pinned; the raw scaled integer otherwise. */
  size: number;
  /** False when `size` and `entryUsd` are raw, unscaled venue integers. */
  scaled: boolean;
  leverageX: number;
  entryUsd: number | null;
}

const BY_ID = new Map<number, Market>(
  Object.values(EXECUTABLE_MARKETS).map((m) => [m.id, m]),
);

export function describePositions(
  frames: readonly OpenPositionFrame[],
): PositionView[] {
  return frames.map((p) => {
    const m = BY_ID.get(p.marketId);
    return {
      pid: p.pid,
      market: m ? m.symbol : `#${p.marketId}`,
      side: p.side === 1 ? "long" : p.side === 2 ? "short" : "unknown",
      size: m ? p.sizeScaled / 10 ** m.sizeDecimals : p.sizeScaled,
      scaled: m !== undefined,
      leverageX: p.leverageX100 / 100,
      entryUsd:
        p.entryPriceScaled === null
          ? null
          : m
            ? p.entryPriceScaled / 10 ** m.priceDecimals
            : p.entryPriceScaled,
    };
  });
}

/**
 * True when opening `side` on `market` would trade against a position already
 * open there. Adding to a long is fine; a short against it is not, and neither
 * is anything on a side we cannot read.
 */
export function opensAgainst(
  positions: readonly PositionView[],
  market: string,
  side: "long" | "short",
): boolean {
  return positions.some((p) => p.market === market && p.side !== side);
}

/**
 * Unrealized loss, in USD, on the positions an add to `side` on `market` would
 * grow. Zero when they are in profit.
 *
 * An add to a losing position must post collateral for that loss on top of its
 * own margin. On 2026-11-02 a $25.35 add against $26.00 free, with the MON long
 * $2.43 under water, came back InsufficientCollateralIncrease (fr 2).
 *
 * Price PnL only: funding owed is not on the position frame. Callers keep a
 * buffer for it. A position we cannot read in USD (unscaled, no entry) counts
 * as unknown and returns null, so the caller refuses rather than guesses.
 */
export function addLossUsd(
  positions: readonly PositionView[],
  market: string,
  side: "long" | "short",
  markUsd: number,
): number | null {
  let loss = 0;
  for (const p of positions) {
    if (p.market !== market || p.side !== side) continue;
    if (!p.scaled || p.entryUsd === null) return null;
    const pnl =
      side === "long"
        ? (markUsd - p.entryUsd) * p.size
        : (p.entryUsd - markUsd) * p.size;
    if (pnl < 0) loss += -pnl;
  }
  return loss;
}
