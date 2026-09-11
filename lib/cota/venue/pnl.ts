// Fills-VWAP PnL reconstruction — the daily-loss read Perpl's frames can't give.
//
// Perpl's position frames carry size but no entry price or PnL (see
// reference: account-state.ts), so loss can't be read from them. But Cota
// PLACES every order, so it sees each fill (mt 25, with price and fee) and knows
// the order's direction (the T_* type it sent). Fold those fills and you
// recover, from data we own: the open position's VWAP entry, realised PnL, and —
// with a mark — unrealised PnL. That is everything the daily-loss ceiling needs.
//
// Pure and deterministic: fills in, numbers out. No socket, no DB. The live
// layer records fills into a ledger and calls this; reconciliation against the
// venue's position snapshot (for size the venue may have liquidated) is the
// caller's job.

import { USD_SCALE, type MarkedMarket } from "./account-state";

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

/** Unrealised PnL in USD across open positions. Throws on a missing mark. */
export function unrealisedUsd(
  positions: OpenPos[],
  marksByMarketId: Map<number, MarkedMarket>,
): number {
  let u = 0;
  for (const p of positions) {
    const mm = marksByMarketId.get(p.marketId);
    if (!mm) {
      throw new Error(
        `no mark for held market ${p.marketId}; cannot price PnL`,
      );
    }
    u += p.signedSize * (mm.markUsd - p.entryUsd);
  }
  return u;
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
 * ceiling, and the real conservatism (never skip a held market) lives in the
 * mark lookups that throw.
 */
export function lossTodayUsdE6(
  fills: LedgerFill[],
  marksByMarketId: Map<number, MarkedMarket>,
  nowMs: number,
): bigint {
  const { positions, realized } = foldFills(fills);
  const net =
    realizedTodayUsd(realized, nowMs) +
    unrealisedUsd(positions, marksByMarketId);
  const loss = net < 0 ? -net : 0;
  return BigInt(Math.round(loss * USD_SCALE));
}
