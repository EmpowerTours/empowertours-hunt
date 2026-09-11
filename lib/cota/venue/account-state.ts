// Turning Perpl's live account into the DayState the leash is checked against.
//
// enforce.ts gates on three aggregate numbers: tradesToday, openNotionalUsdE6,
// lossTodayUsdE6. This module builds the two that Perpl's frames actually
// support (open notional from positions × mark; trades today from fills) and is
// deliberately HONEST about the third: the venue's position frames carry no
// entry price or PnL (src/account_status.py), so loss cannot be read from them.
// That number is left null — never silently zero — so a caller enforcing the
// daily-loss stop fails closed instead of running with the ceiling disabled.

import type { Market } from "../order";
import type { DayState } from "../enforce";
import type { OpenPositionFrame } from "./frames";

/** USD micro-dollars, the unit every *UsdE6 field in enforce.ts is in. */
export const USD_SCALE = 1_000_000;

export interface MarkedMarket {
  market: Market;
  /** Current mark price in USD (from market-data.ts::readMark). */
  markUsd: number;
}

/**
 * Aggregate open notional in USD-E6 from open positions and their marks:
 * `Σ |sizeUnits| × mark`, side irrelevant (a short and a long of equal size
 * carry equal notional against the cap).
 *
 * Every held market MUST have a mark. A missing one would UNDER-report and
 * silently loosen the aggregate cap the user signed, so this throws rather than
 * skip it — the conservative contract from src/cota.py::open_notional_from_positions.
 * Rounds UP, so the reported notional never sits below the true one.
 */
export function openNotionalUsdE6(
  positions: OpenPositionFrame[],
  marksByMarketId: Map<number, MarkedMarket>,
): bigint {
  let total = 0n;
  for (const p of positions) {
    const mm = marksByMarketId.get(p.marketId);
    if (!mm) {
      throw new Error(
        `no mark for held market ${p.marketId}; cannot bound open notional`,
      );
    }
    const sizeUnits = Math.abs(p.sizeScaled) / 10 ** mm.market.sizeDecimals;
    const notionalUsd = sizeUnits * mm.markUsd;
    total += BigInt(Math.ceil(notionalUsd * USD_SCALE));
  }
  return total;
}

export interface AggregateState {
  openNotionalUsdE6: bigint;
  tradesToday: number;
  /**
   * Loss so far today in USD-E6, or null when it could not be read. NULL IS NOT
   * ZERO. Perpl's position frames carry no entry/PnL, so until the loss read is
   * solved (fills-VWAP reconstruction, or a venue equity field found via
   * Mandate's capture_position_frames diagnostic) this stays null, and a caller
   * enforcing the daily-loss stop MUST refuse on null rather than pass zero —
   * zero silently disables the ceiling the user signed.
   */
  lossTodayUsdE6: bigint | null;
}

/**
 * Convert to enforce.ts's DayState, or null when loss is unknown. A null return
 * means the daily-loss bound cannot be verified right now, and the only safe
 * response is to refuse the order — never to substitute zero.
 */
export function toDayState(s: AggregateState): DayState | null {
  if (s.lossTodayUsdE6 === null) return null;
  return {
    tradesToday: s.tradesToday,
    lossTodayUsdE6: s.lossTodayUsdE6,
    openNotionalUsdE6: s.openNotionalUsdE6,
  };
}
