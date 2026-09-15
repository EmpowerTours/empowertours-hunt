// Fills-VWAP reconstruction — the REALISED half of the daily-loss read.
//
// This module was built on the premise that Perpl's position frames carry no
// entry price, so everything — entry, realised, unrealised — had to be
// reconstructed from our own fills. The premise was wrong: the frame carries
// `ep`, verified to the microdollar against the venue's own totals (see
// parsePositions in frames.ts).
//
// So the split is now by WHO KNOWS THE ANSWER. The venue knows what is open and
// what it was entered at, so UNREALISED PnL is computed from its `ep` in
// aggregate.ts — authoritative, and immune to drift in our reconstruction. Only
// REALISED PnL for the current day is something the venue does not give per day,
// and that stays here, folded from the fills we recorded.
//
// The fold's VWAP entry survives for one job it is still the only source for:
// cross-checking our ledger against the venue's `ep`. Size agreeing is not the
// ledger being right, and that second dimension is what catches a ledger that is
// wrong about the price rather than the quantity.
//
// Pure and deterministic: fills in, numbers out. No socket, no DB.

import { USD_SCALE } from "./account-state";

export interface LedgerFill {
  marketId: number;
  /** +1 = buy (opens/adds long, covers short); -1 = sell. From the order type. */
  direction: 1 | -1;
  /** Absolute fill size in market units (already descaled). */
  sizeUnits: number;
  /** Fill price in USD. */
  priceUsd: number;
  /** Total fee in USD (>= 0). Always reduces PnL, on opens and closes alike. */
  feeUsd: number;
  /** Fill time, ms epoch. */
  timestampMs: number;
  /** Order id/rq, to count distinct orders per day. */
  orderId: number;
}

export interface OpenPos {
  marketId: number;
  /** Signed size: > 0 long, < 0 short. */
  signedSize: number;
  /** VWAP entry price in USD of the currently-open size. */
  entryUsd: number;
}

export interface RealizedEvent {
  marketId: number;
  /** + profit, - loss. Includes this fill's close PnL minus its fee. */
  realizedUsd: number;
  timestampMs: number;
}

// Sizes are floats; treat anything under this as flat, so a close that should
// zero a position doesn't leave 1e-15 behind and mis-price the next fill.
const EPS = 1e-9;

/**
 * Fold fills (any order) into current open positions and the realised-PnL
 * stream. A fill that reduces or flips a position realises PnL on the closed
 * portion; a fill that opens or adds updates the VWAP entry. Every fill's fee is
 * realised immediately (a cost is a cost whether it opened or closed).
 */
export function foldFills(fills: LedgerFill[]): {
  positions: OpenPos[];
  realized: RealizedEvent[];
} {
  const ordered = [...fills].sort((a, b) => a.timestampMs - b.timestampMs);
  const pos = new Map<number, { signedSize: number; entryUsd: number }>();
  const realized: RealizedEvent[] = [];

  for (const f of ordered) {
    const st = pos.get(f.marketId) ?? { signedSize: 0, entryUsd: 0 };
    const delta = f.direction * f.sizeUnits;
    let closePnl = 0;

    if (st.signedSize === 0 || Math.sign(st.signedSize) === Math.sign(delta)) {
      // Opening or adding in the same direction — VWAP the entry.
      const absOld = Math.abs(st.signedSize);
      const absAdd = Math.abs(delta);
      st.entryUsd =
        absOld + absAdd === 0
          ? f.priceUsd
          : (absOld * st.entryUsd + absAdd * f.priceUsd) / (absOld + absAdd);
      st.signedSize += delta;
    } else {
      // Opposing fill — realise on the closed portion.
      const sideSign = st.signedSize > 0 ? 1 : -1;
      const closing = Math.min(Math.abs(st.signedSize), Math.abs(delta));
      closePnl = closing * (f.priceUsd - st.entryUsd) * sideSign;
      st.signedSize += delta;
      if (Math.abs(st.signedSize) < EPS) {
        st.signedSize = 0;
        st.entryUsd = 0;
      } else if (Math.sign(st.signedSize) !== sideSign) {
        // Flipped through zero — the remainder is a new position at this price.
        st.entryUsd = f.priceUsd;
      }
      // Partial reduce (same sign): entry unchanged.
    }

    realized.push({
      marketId: f.marketId,
      realizedUsd: closePnl - f.feeUsd,
      timestampMs: f.timestampMs,
    });

    if (st.signedSize === 0) pos.delete(f.marketId);
    else pos.set(f.marketId, st);
  }

  return {
    positions: [...pos.entries()].map(([marketId, s]) => ({
      marketId,
      signedSize: s.signedSize,
      entryUsd: s.entryUsd,
    })),
    realized,
  };
}

/** Start of the UTC day containing `ms`. */
function utcDayStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Realised PnL (+profit/-loss) inside the current UTC day. */
export function realizedTodayUsd(
  realized: RealizedEvent[],
  nowMs: number,
): number {
  const dayStart = utcDayStart(nowMs);
  return realized
    .filter((r) => r.timestampMs >= dayStart)
    .reduce((s, r) => s + r.realizedUsd, 0);
}

/** Distinct orders placed inside the current UTC day. */
export function countOrdersToday(fills: LedgerFill[], nowMs: number): number {
  const dayStart = utcDayStart(nowMs);
  const ids = new Set<number>();
  for (const f of fills) if (f.timestampMs >= dayStart) ids.add(f.orderId);
  return ids.size;
}

/**
 * Loss so far today in USD-E6, positive meaning down — realised today PLUS all
 * current unrealised (a position sitting at a loss has lost the money whether or
 * not it was closed; matches enforce.ts and Mandate's account_state_from). A day
 * that is up reports zero, never negative — no free headroom. Rounded to the
 * nearest micro-dollar; sub-cent rounding is immaterial to a dollar-scale
 * ceiling.
 *
 * `unrealisedNowUsd` is PASSED IN, not derived here, because the venue is the
 * authority on it: it comes from the position frame's `ep` via
 * aggregate.ts::unrealisedFromVenueUsd. Deriving it from the fold as well would
 * be a second way to compute the number the leash gates on, and the two would
 * drift — the same failure as the duplicated boundFromRow, where a UI could
 * preview "allowed" on an order the server refuses.
 */
export function lossTodayUsdE6(
  fills: LedgerFill[],
  unrealisedNowUsd: number,
  nowMs: number,
): bigint {
  const { realized } = foldFills(fills);
  const net = realizedTodayUsd(realized, nowMs) + unrealisedNowUsd;
  const loss = net < 0 ? -net : 0;
  return BigInt(Math.round(loss * USD_SCALE));
}
