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
