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
  /**
   * Fees in USD the ledger has recorded against the CURRENTLY OPEN run — reset
   * when the position goes flat, restarted when it flips through zero.
   *
   * It exists to be differenced against the venue's `fee` on the position frame,
   * which accumulates the same way (5273: 4440 after the first fill, 7113 after
   * the second). Adoption needs to know what share of that total is already on
   * the books, or it attributes the whole position's fees to one delta and the
   * loss figure drifts up on every adoption.
   */
  feesUsd: number;
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
  const pos = new Map<
    number,
    { signedSize: number; entryUsd: number; feesUsd: number }
  >();
  const realized: RealizedEvent[] = [];

  for (const f of ordered) {
    const st = pos.get(f.marketId) ?? {
      signedSize: 0,
      entryUsd: 0,
      feesUsd: 0,
    };
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
      st.feesUsd += f.feeUsd;
    } else {
      // Opposing fill — realise on the closed portion.
      const sideSign = st.signedSize > 0 ? 1 : -1;
      const closing = Math.min(Math.abs(st.signedSize), Math.abs(delta));
      closePnl = closing * (f.priceUsd - st.entryUsd) * sideSign;
      st.signedSize += delta;
      if (Math.abs(st.signedSize) < EPS) {
        st.signedSize = 0;
        st.entryUsd = 0;
        st.feesUsd = 0;
      } else if (Math.sign(st.signedSize) !== sideSign) {
        // Flipped through zero — the remainder is a new position at this price,
        // and this fill's fee is the fee that opened it. The run it closed is
        // gone, and so is the fee total that belonged to it.
        st.entryUsd = f.priceUsd;
        st.feesUsd = f.feeUsd;
      } else {
        // Partial reduce: entry unchanged, and the fee was still charged
        // against this same open position, which is how the venue counts it.
        st.feesUsd += f.feeUsd;
      }
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
      feesUsd: s.feesUsd,
    })),
    realized,
  };
}

/**
 * Start of the UTC day containing `ms`.
 *
 * Exported so the query that loads today's orders uses the SAME boundary the
 * count applies. Two definitions of "today" would let the loader and the
 * counter disagree about which orders exist, which is how a ceiling quietly
 * stops matching its own input.
 */
export function utcDayStartMs(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Realised PnL (+profit/-loss) inside the current UTC day. */
export function realizedTodayUsd(
  realized: RealizedEvent[],
  nowMs: number,
): number {
  const dayStart = utcDayStartMs(nowMs);
  return realized
    .filter((r) => r.timestampMs >= dayStart)
    .reduce((s, r) => s + r.realizedUsd, 0);
}

/** An order this agent sent and the venue accepted, filled or not yet. */
export interface PlacedOrder {
  orderId: number;
  placedAtMs: number;
}

/**
 * Distinct orders this agent placed inside the current UTC day — the number the
 * signed `maxTradesPerDay` is measured against.
 *
 * It counts FILLS and PLACED ORDERS together, and that second half is the whole
 * point. Counting fills alone let the ceiling lag reality by however long the
 * venue took to fill: an order that was sent, accepted and gated did not count
 * until its fill came back, so N orders in quick succession each saw
 * `tradesToday` near zero and each passed. On 2026-09-15 account 5273 sent nine
 * orders against two recorded fills, so the counter read two. A ceiling the user
 * signed, that is in enforce.ts and in the UI, and that never bound — the same
 * failure as the hardcoded `rq` collapsing this very count to 1, one layer up.
 *
 * The union deduplicates for free because an adopted fill is recorded under the
 * `orderId` of the pending order it settles (verified against account 5273:
 * fill and CotaOrder both carry 293302356). So a placed order that later fills
 * is one trade, not two.
 *
 * A trade counts from the moment it is SENT, not from when it succeeds. An
 * order the venue refused still consumed an attempt the hunter authorised, and
 * the alternative — free retries — is what a rate ceiling exists to stop.
 */
/**
 * The orderId an ADOPTED fill carries when no order of this agent's explains it
 * — the hunter reconciled a position by hand.
 *
 * newAgentOrderId() never returns 0 (it draws from 1..2^31-1) and an
 * automatically adopted fill inherits its pending order's id, so zero is
 * unambiguous: it means "the venue already had this, and a person told us to
 * write it down".
 */
export const ADOPTED_NOT_ORDERED = 0;

export function countOrdersToday(
  fills: LedgerFill[],
  placed: PlacedOrder[],
  nowMs: number,
): number {
  const dayStart = utcDayStartMs(nowMs);
  const ids = new Set<number>();
  for (const f of fills) {
    if (f.timestampMs < dayStart) continue;
    // An adoption is not a trade. It records a fill the venue had already
    // executed, usually one this agent placed and failed to see — charging the
    // hunter a slot for our bookkeeping would spend their allowance on our bug,
    // and would do it at the exact moment they were unblocking themselves.
    if (f.orderId === ADOPTED_NOT_ORDERED) continue;
    ids.add(f.orderId);
  }
  for (const o of placed) if (o.placedAtMs >= dayStart) ids.add(o.orderId);
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
