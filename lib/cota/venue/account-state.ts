// Turning Perpl's live account into the DayState the leash is checked against.
//
// enforce.ts gates on three aggregate numbers: tradesToday, openNotionalUsdE6,
// lossTodayUsdE6. This module builds open notional (positions × mark) and holds
// the AggregateState shape; loss is assembled in aggregate.ts.
//
// This file used to say the venue's frames carry no entry price or PnL, citing
// src/account_status.py. That was never a survey of what the venue sends — only
// of what Mandate parsed — and it is false: the position frame carries `ep`. So
// unrealised PnL is read from the venue and realised-today folded from our
// fills. What survives unchanged is the contract around NOT KNOWING: loss stays
// `bigint | null`, null is never zero, and a caller enforcing the daily-loss
// stop fails closed rather than run with the ceiling silently disabled.

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
   * Loss so far today in USD-E6, or null when it could not be vouched for.
   * NULL IS NOT ZERO.
   *
   * It is null when our fill ledger does not reconcile with the venue's
   * positions in size AND entry price: the venue gives no per-day realised PnL,
   * so that half comes from our fills, and a ledger that disagrees with the
   * venue is missing closes that realised a loss today. A caller enforcing the
   * daily-loss stop MUST refuse on null rather than pass zero — zero silently
   * disables the ceiling the user signed.
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
