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
 * How far an open position is down, as basis points of its collateral, or null
 * when it cannot be priced. Zero when it is not losing.
 *
 * Collateral is taken as size × entry ÷ leverage. The venue keeps each
 * position's collateral apart from the account balance (`c` on the mt 26 frame:
 * 2.504014 on the 214 MON 2x long from 0.023308, i.e. that margin plus its fee),
 * so this slightly understates it and slightly overstates the ratio.
 */
export function lossBpsOfCollateral(
  p: PositionView,
  markUsd: number,
): number | null {
  if (
    !p.scaled ||
    p.side === "unknown" ||
    p.entryUsd === null ||
    !(p.entryUsd > 0) ||
    !(markUsd > 0) ||
    !(p.leverageX > 0)
  ) {
    return null;
  }
  const collateral = (p.size * p.entryUsd) / p.leverageX;
  const loss =
    p.side === "long"
      ? (p.entryUsd - markUsd) * p.size
      : (markUsd - p.entryUsd) * p.size;
  return Math.max(0, Math.round((loss / collateral) * 10_000));
}

/**
 * Whether Perpl will refuse to add to the open position on `market`.
 *
 * The market's context carries `order_max_neg_pnl_collat_bps` (300 on MON), and
 * every order carries a matching `maxNegPnlCollatBPS` (perpl-sdk 0.2.4,
 * OrderRequest). Five orders adding to a 395 MON long that was 22% down came
 * back TakerOrderSettlementFailed on 2026-10-31, from $15.85 to $26 against
 * $26.00 free. Reading the field by its name, a position losing more than that
 * share of its collateral cannot be added to, at any size. Checked here so the
 * money is not swapped and deposited first for an order that cannot settle.
 *
 * `unknown` when it cannot be judged — no limit published, or a position that
 * cannot be priced. The caller refuses on that too.
 */
export function addBlockedByLoss(args: {
  positions: readonly PositionView[];
  market: string;
  markUsd: number | null;
  limitBps: number | null;
}):
  | { blocked: false }
  | { blocked: true; lossBps: number; limitBps: number }
  | { blocked: "unknown" } {
  const open = args.positions.filter((p) => p.market === args.market);
  if (open.length === 0) return { blocked: false };
  if (args.markUsd === null || args.limitBps === null)
    return { blocked: "unknown" };
  let worst = 0;
  for (const p of open) {
    const bps = lossBpsOfCollateral(p, args.markUsd);
    if (bps === null) return { blocked: "unknown" };
    worst = Math.max(worst, bps);
  }
  return worst > args.limitBps
    ? { blocked: true, lossBps: worst, limitBps: args.limitBps }
    : { blocked: false };
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
