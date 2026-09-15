// Assemble the DayState inputs from two sources of truth, and refuse to trust a
// loss number we can't vouch for.
//
// The split is by who knows the answer:
//
//   - OPEN NOTIONAL — the venue. Authoritative on current size, and it reflects
//     a liquidation we may have no close-fill for.
//   - UNREALISED PnL — the venue, from each position's `ep`. This used to be
//     reconstructed from our fills because the frame was believed to carry no
//     entry price. It does, so it is read rather than rebuilt: `ep` is what the
//     venue will actually settle against, and a reconstruction can drift from it
//     while agreeing on size, which the old size-only check could not see.
//   - REALISED PnL TODAY — our fill ledger. The one number the venue gives no
//     per-day view of, so it is still folded from the fills we recorded.
//
// The ledger being complete therefore still gates the loss: if the venue holds
// size we have no fills for — a manual trade on a shared account, or size we
// mis-tracked — then closes it realised today are missing from our fold, and a
// loss built on it silently under-reports the day's drawdown. The only safe
// answer there is null (fail closed), never a number.
//
// Reconciliation now checks BOTH dimensions. Size agreeing is not the ledger
// being right; a ledger that is wrong about the PRICE paid produces the correct
// size and the wrong loss, which is exactly the kind of silent error this
// module exists to refuse.

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
  type PlacedOrder,
} from "./pnl";
import type { OpenPositionFrame } from "./frames";

// Positions are floats through descaling; anything under this is "the same size".
const RECON_EPS = 1e-6;

/**
 * How far our folded VWAP entry may sit from the venue's `ep` before the ledger
 * is treated as wrong about the price.
 *
 * Two terms, because either can dominate. One price tick is the venue's own
 * rounding granularity — our fold averages in floats, `ep` arrives already
 * rounded to price_decimals, and a disagreement that small is arithmetic, not
 * error. Ten basis points is the size at which a disagreement starts to matter
 * to a dollar-scale loss ceiling: below it the effect on the loss number is
 * immaterial, above it the ledger and the venue genuinely disagree about what
 * was paid and the loss built from our side cannot be trusted.
 */
const ENTRY_RECON_BPS = 10;

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
 * Entry price in USD from a venue frame's `ep`, or null when the frame omitted
 * it. Descaled by the market's price_decimals, the same way toPrice scales it.
 */
export function entryUsdFromFrame(
  f: OpenPositionFrame,
  marks: Map<number, MarkedMarket>,
): number | null {
  const mm = marks.get(f.marketId);
  if (!mm) {
    throw new Error(`no market for held market ${f.marketId}`);
  }
  if (f.entryPriceScaled === null) return null;
  return f.entryPriceScaled / 10 ** mm.market.priceDecimals;
}

/**
 * Unrealised PnL in USD across the venue's open positions, priced from the
 * venue's own `ep`: `Σ signedSize × (mark − ep)`.
 *
 * Throws rather than skip a position, on either a missing mark or a missing
 * `ep`. Skipping one would UNDER-report the day's loss and silently loosen the
 * ceiling the hunter signed — the same contract openNotionalUsdE6 keeps, and the
 * reason it throws too.
 *
 * A missing `ep` surfaces as state_unavailable ("try again shortly") rather than
 * loss_unverifiable, and that is deliberate: the reconcile path a hunter would
 * be sent to adopts a position AT the venue's `ep`, so with `ep` absent there is
 * nothing for them to do about it. A frame that omits it is a read to retry, not
 * a decision to escalate.
 */
export function unrealisedFromVenueUsd(
  venuePositions: OpenPositionFrame[],
  marks: Map<number, MarkedMarket>,
): number {
  let u = 0;
  for (const f of venuePositions) {
    const mm = marks.get(f.marketId);
    if (!mm) {
      throw new Error(
        `no mark for held market ${f.marketId}; cannot price PnL`,
      );
    }
    const entryUsd = entryUsdFromFrame(f, marks);
    if (entryUsd === null) {
      throw new Error(
        `venue sent no entry price (ep) for open position ${f.pid} on market ` +
          `${f.marketId}; cannot price unrealised PnL`,
      );
    }
    u += signedSizeFromFrame(f, marks) * (mm.markUsd - entryUsd);
  }
  return u;
}

/**
 * Does our fills-derived position set match the venue's, market by market, in
 * BOTH size and entry price? A mismatch in either means the ledger is wrong and
 * the realised PnL folded from it can't be trusted.
 */
export function positionsReconcile(
  fold: OpenPos[],
  venue: OpenPositionFrame[],
  marks: Map<number, MarkedMarket>,
): boolean {
  const foldByMkt = new Map(fold.map((p) => [p.marketId, p]));
  const venueByMkt = new Map(venue.map((v) => [v.marketId, v]));
  const markets = new Set([...foldByMkt.keys(), ...venueByMkt.keys()]);
  for (const m of markets) {
    const f = foldByMkt.get(m);
    const v = venueByMkt.get(m);
    const a = f?.signedSize ?? 0;
    const b = v ? signedSizeFromFrame(v, marks) : 0;
    if (Math.abs(a - b) > RECON_EPS) return false;

    // Sizes agree. Now the price: a ledger holding the right quantity at the
    // wrong entry yields the right notional and the wrong loss, and the
    // size-only check this replaced passed it through.
    if (!f || !v) continue;
    const venueEntry = entryUsdFromFrame(v, marks);
    // No `ep` to compare against is not a mismatch. unrealisedFromVenueUsd is
    // what refuses on that, with a message naming the position.
    if (venueEntry === null) continue;
    const mm = marks.get(m);
    const tick = mm ? 1 / 10 ** mm.market.priceDecimals : 0;
    const tolerance = Math.max(
      tick,
      (Math.abs(venueEntry) * ENTRY_RECON_BPS) / 10_000,
    );
    if (Math.abs(f.entryUsd - venueEntry) > tolerance) return false;
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
  /**
   * Orders this agent sent and the venue accepted today, filled or not. Without
   * them the trades-per-day ceiling only sees fills and lags the orders it is
   * supposed to be limiting.
   */
  placedOrders: PlacedOrder[];
  venuePositions: OpenPositionFrame[];
  marks: Map<number, MarkedMarket>;
  nowMs: number;
}): AggregateState {
  const { fills, placedOrders, venuePositions, marks, nowMs } = args;
  const { positions } = foldFills(fills);
  const reconciled = positionsReconcile(positions, venuePositions, marks);
  return {
    openNotionalUsdE6: openNotionalUsdE6(venuePositions, marks),
    tradesToday: countOrdersToday(fills, placedOrders, nowMs),
    // Unrealised from the venue's `ep`, realised from our fold — and the whole
    // number withheld unless the two sources agree about what is open and what
    // it cost.
    lossTodayUsdE6: reconciled
      ? lossTodayUsdE6(
          fills,
          unrealisedFromVenueUsd(venuePositions, marks),
          nowMs,
        )
      : null,
  };
}
