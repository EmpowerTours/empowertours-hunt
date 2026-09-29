// Round trips — the fill ledger folded into "what did that trade make".
//
// WHY THIS EXISTS. The ledger recorded four real fills in September, the
// position closed at a profit, and the hunter had no way to see it. /cota/risk
// reads OPEN exposure from the venue, so a flat account renders "no position"
// and stops; the trade screen lists what the agent DECIDED, not what it earned.
// The only answer available was "open the venue's own site with your wallet",
// which is an absurd thing for a product whose entire claim is that it holds
// your leash to say.
//
// THE MONEY IS NOT COMPUTED HERE. Every currency figure comes from foldFills in
// pnl.ts, which is the reconciled, tested implementation that the daily-loss
// ceiling already enforces against. A second PnL implementation would be two
// numbers that can disagree, and the one on the screen would be the one nobody
// checks. This module does grouping and VWAPs only: it decides which fills
// belong to the same round trip, and sums foldFills' own per-fill realised
// figures within each.
//
// So a trip's `netUsd` is exactly the slice of realised PnL the leash counted.
// If this screen and the loss ceiling ever disagree, it is a bug in one line of
// arithmetic here, not in two rival models of a position.

import { foldFills, type LedgerFill } from "./pnl";

export interface Trip {
  marketId: number;
  /** Which way the position was opened. */
  side: "long" | "short";
  /** Units closed (for an open trip, units still held). */
  units: number;
  /** VWAP of the fills that opened the position. */
  entryUsd: number;
  /** VWAP of the fills that closed it — null while the trip is still open. */
  exitUsd: number | null;
  /** Every fee charged inside the trip, opens and closes alike. */
  feesUsd: number;
  /**
   * Realised, after fees, summed from foldFills' own per-fill figures.
   *
   * For an OPEN trip this is negative or zero: fees paid so far and nothing
   * realised. It is not the trip's eventual result and must not be shown as one
   * — /cota/risk holds the mark-to-market for that.
   */
  netUsd: number;
  openedAtMs: number;
  /** Null while open. */
  closedAtMs: number | null;
  open: boolean;
  /** How many fills the trip took. */
  fills: number;
}

export interface Ledger {
  /** Newest first, which is the order a screen wants. */
  trips: Trip[];
  /** Realised across every CLOSED trip, after fees. */
  realisedUsd: number;
  /** Every fee the ledger has ever recorded, open trips included. */
  feesUsd: number;
  closed: number;
  open: number;
}

// Sizes are floats; below this a position is flat. Same threshold foldFills
// uses, for the same reason — a close that should zero a position must not
// leave 1e-15 behind and start a phantom trip on the other side.
const EPS = 1e-9;

interface Run {
  side: "long" | "short";
  signed: number;
  openUnits: number;
  openValue: number;
  closeUnits: number;
  closeValue: number;
  feesUsd: number;
  netUsd: number;
  openedAtMs: number;
  fills: number;
  marketId: number;
}

function finish(r: Run, closedAtMs: number | null): Trip {
  const open = closedAtMs === null;
  return {
    marketId: r.marketId,
    side: r.side,
    units: open ? Math.abs(r.signed) : r.closeUnits,
    entryUsd: r.openUnits > 0 ? r.openValue / r.openUnits : 0,
    exitUsd: r.closeUnits > 0 ? r.closeValue / r.closeUnits : null,
    feesUsd: r.feesUsd,
    netUsd: r.netUsd,
    openedAtMs: r.openedAtMs,
    closedAtMs,
    open,
    fills: r.fills,
  };
}

/**
 * Group fills into round trips.
 *
 * A trip runs from flat to flat in one market. A fill that flips straight
 * through zero closes the trip it was reducing and opens a new one with the
 * remainder — the same treatment foldFills gives it, so the two stay aligned.
 */
export function tripsFromFills(fills: readonly LedgerFill[]): Ledger {
  // The SAME ordering foldFills applies, so realised[i] belongs to ordered[i].
  // Array sort is stable and re-sorting a sorted array is identity, so the two
  // orderings cannot drift apart.
  const ordered = [...fills].sort((a, b) => a.timestampMs - b.timestampMs);
  const { realized } = foldFills(ordered);

  const done: Trip[] = [];
  const live = new Map<number, Run>();

  ordered.forEach((f, i) => {
    // foldFills pushes exactly one event per fill, in this order: close PnL on
    // the portion this fill closed, less this fill's fee.
    const net = realized[i]?.realizedUsd ?? -f.feeUsd;
    const delta = f.direction * f.sizeUnits;
    const run = live.get(f.marketId);

    if (!run) {
      live.set(f.marketId, {
        marketId: f.marketId,
        side: delta > 0 ? "long" : "short",
        signed: delta,
        openUnits: f.sizeUnits,
        openValue: f.sizeUnits * f.priceUsd,
        closeUnits: 0,
        closeValue: 0,
        feesUsd: f.feeUsd,
        netUsd: net,
        openedAtMs: f.timestampMs,
        fills: 1,
      });
      return;
    }

    run.fills += 1;
    run.feesUsd += f.feeUsd;
    run.netUsd += net;

    if (Math.sign(delta) === Math.sign(run.signed)) {
      run.openUnits += f.sizeUnits;
      run.openValue += f.sizeUnits * f.priceUsd;
      run.signed += delta;
      return;
    }

    const closing = Math.min(Math.abs(run.signed), f.sizeUnits);
    const remainder = f.sizeUnits - closing;
    run.closeUnits += closing;
    run.closeValue += closing * f.priceUsd;
    run.signed += Math.sign(delta) * closing;

    if (Math.abs(run.signed) >= EPS) return;

    done.push(finish(run, f.timestampMs));
    live.delete(f.marketId);

    if (remainder > 0) {
      // Flipped through zero. The remainder is a new position entered at this
      // price; its fee already belongs to the trip that just closed, which is
      // how foldFills accounts for it too.
      live.set(f.marketId, {
        marketId: f.marketId,
        side: delta > 0 ? "long" : "short",
        signed: Math.sign(delta) * remainder,
        openUnits: remainder,
        openValue: remainder * f.priceUsd,
        closeUnits: 0,
        closeValue: 0,
        feesUsd: 0,
        netUsd: 0,
        openedAtMs: f.timestampMs,
        fills: 1,
      });
    }
  });

  const openTrips = [...live.values()].map((r) => finish(r, null));
  const all = [...done, ...openTrips].sort(
    (a, b) => b.openedAtMs - a.openedAtMs,
  );

  return {
    trips: all,
    realisedUsd: done.reduce((s, t) => s + t.netUsd, 0),
    feesUsd: all.reduce((s, t) => s + t.feesUsd, 0),
    closed: done.length,
    open: openTrips.length,
  };
}
