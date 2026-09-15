// Bringing the fill ledger back into agreement with the venue — and being exact
// about when that is safe.
//
// The ledger and the venue disagree whenever a fill lands after the socket that
// placed it has closed. Perpl accepts an order on the gateway and fills it on
// the chain a moment later, so this is not an edge case: it is what happens to
// every hunter's first fill (account 5273, 2026-09-14 — 214 MON open, ledger
// empty, every later order refused).
//
// aggregate.ts is right to fail closed on a mismatch, so the fix is not to
// loosen it. The fix is to record the missing fill. The question is at what
// price, and on whose say-so:
//
//   PRICE — the venue's own `ep` on the position frame, never a mark, never a
//   guess. A position with no `ep` cannot be adopted at all; it is reported as
//   unexplained and the caller keeps failing closed. Pricing an adoption at
//   anything but the venue's entry would put a fabricated number straight into
//   the daily-loss ceiling the hunter signed.
//
//   SAY-SO — a delta the agent's OWN pending order accounts for may be adopted
//   automatically: the agent authorised that order under the leash and watched
//   the venue accept it, so recording its fill is bookkeeping, not a new
//   decision. A delta nothing accounts for — size the hunter opened elsewhere,
//   a shared account — is NOT adopted automatically at any price. It surfaces
//   as unexplained, the caller refuses, and adopting it takes a deliberate act
//   by the hunter. Collapsing those two cases is the one mistake this module
//   exists to prevent: it would either block every hunter or silently swallow
//   trades the agent never made.

import type { MarkedMarket } from "./account-state";
import type { LedgerFill, OpenPos } from "./pnl";
import type { OpenPositionFrame } from "./frames";
import { signedSizeFromFrame } from "./aggregate";

/** Sizes are floats through descaling; below this the two sides agree. */
const EPS = 1e-6;

/**
 * How long an accepted-but-unfilled order stays able to explain a position.
 *
 * An order the venue acked and then never forwarded leaves a pending row that
 * nothing will ever resolve — which is not hypothetical: account 5273 has two,
 * from orders that carried a stale `rq`. A row like that must not sit around
 * indefinitely waiting to "explain" a position the hunter opens by hand a week
 * later, because that is exactly the silent adoption this module exists to
 * prevent. A fill that is going to land lands in seconds; half an hour is
 * generous and still bounded.
 */
export const PENDING_MAX_AGE_MS = 30 * 60 * 1000;

/** An order this agent placed and the venue accepted, still unaccounted for. */
export interface PendingOrder {
  id: string;
  marketId: number;
  /** +1 buy, -1 sell. */
  direction: 1 | -1;
  sizeUnits: number;
  orderId: number;
  placedAtMs: number;
}

export interface Unexplained {
  marketId: number;
  /** Signed size the venue holds that the ledger cannot account for. */
  deltaUnits: number;
  reason: "no_pending_order" | "no_entry_price" | "ledger_holds_more";
}

export interface AdoptionPlan {
  /** Synthetic fills to record, priced at the venue's own entry. */
  fills: LedgerFill[];
  /** Pending order ids fully accounted for by those fills. */
  resolvedOrderIds: string[];
  /** Deltas that must NOT be adopted without the hunter saying so. */
  unexplained: Unexplained[];
}

function deltaByMarket(
  fold: OpenPos[],
  venue: OpenPositionFrame[],
  marks: Map<number, MarkedMarket>,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const p of fold)
    out.set(p.marketId, (out.get(p.marketId) ?? 0) - p.signedSize);
  for (const v of venue) {
    out.set(
      v.marketId,
      (out.get(v.marketId) ?? 0) + signedSizeFromFrame(v, marks),
    );
  }
  return out;
}

/**
 * What it would take to make the ledger agree with the venue.
 *
 * `trust: "pending"` (the automatic path) adopts only deltas a pending order of
 * the same market and direction covers. `trust: "hunter"` (the explicit path)
 * adopts any delta the venue prices, and is only ever reached from a deliberate
 * hunter action.
 *
 * A delta the ledger holds but the venue does not is never adopted either way.
 * That is a close or a liquidation, and the frame that would carry its price is
 * gone — there is nothing honest to record.
 */
export function planAdoption(args: {
  fold: OpenPos[];
  venue: OpenPositionFrame[];
  marks: Map<number, MarkedMarket>;
  pending: PendingOrder[];
  nowMs: number;
  trust: "pending" | "hunter";
}): AdoptionPlan {
  const { fold, venue, marks, pending, nowMs, trust } = args;
  const frames = new Map(venue.map((v) => [v.marketId, v]));
  const fills: LedgerFill[] = [];
  const resolvedOrderIds: string[] = [];
  const unexplained: Unexplained[] = [];

  for (const [marketId, delta] of deltaByMarket(fold, venue, marks)) {
    if (Math.abs(delta) <= EPS) continue;

    const frame = frames.get(marketId);
    if (!frame) {
      // The ledger holds size the venue does not: a close or liquidation whose
      // price left with the position. Never invent one.
      unexplained.push({
        marketId,
        deltaUnits: delta,
        reason: "ledger_holds_more",
      });
      continue;
    }
    if (frame.entryPriceScaled === null) {
      unexplained.push({
        marketId,
        deltaUnits: delta,
        reason: "no_entry_price",
      });
      continue;
    }

    const direction: 1 | -1 = delta > 0 ? 1 : -1;
    const mm = marks.get(marketId);
    if (!mm) throw new Error(`no market for held market ${marketId}`);
    const priceUsd = frame.entryPriceScaled / 10 ** mm.market.priceDecimals;

    // Which of this agent's orders, if any, accounts for the delta.
    //
    // The AGE CAP applies only to the automatic path, and the difference is
    // authorisation versus attribution. Automatically adopting on the strength
    // of a stale row is the silent adoption this module exists to prevent, so
    // there it must be recent. On the hunter's explicit path the decision has
    // already been made by a person, and matching only decides which order to
    // WRITE THE FILL AGAINST — it authorises nothing, so an older row is fine.
    const candidate = (requireRecent: boolean) =>
      pending.find(
        (o) =>
          o.marketId === marketId &&
          o.direction === direction &&
          o.sizeUnits + EPS >= Math.abs(delta) &&
          o.placedAtMs <= nowMs &&
          (!requireRecent || nowMs - o.placedAtMs <= PENDING_MAX_AGE_MS),
      );

    let orderId = 0;
    if (trust === "pending") {
      const match = candidate(true);
      if (!match) {
        unexplained.push({
          marketId,
          deltaUnits: delta,
          reason: "no_pending_order",
        });
        continue;
      }
      orderId = match.orderId;
      resolvedOrderIds.push(match.id);
    } else {
      // Hunter path: adopt regardless, but attribute honestly when one of this
      // agent's own orders explains it. Leaving orderId 0 here made every
      // hunter adoption collapse to one id for the trades-per-day ceiling, and
      // left the order that actually filled sitting open forever — the same
      // fill counted twice, once as the pending row and once as the 0.
      const match = candidate(false);
      if (match) {
        orderId = match.orderId;
        resolvedOrderIds.push(match.id);
      }
    }

    fills.push({
      marketId,
      direction,
      sizeUnits: Math.abs(delta),
      priceUsd,
      // The whole fee the venue has charged this position, not a pro-rated
      // share. A fee is a loss, and over-attributing one makes the daily-loss
      // ceiling bind sooner; under-attributing would let it bind later than the
      // hunter agreed. When in doubt on a loss guard, take the larger number.
      feeUsd: (frame.feeScaled ?? 0) / 1_000_000,
      timestampMs: nowMs,
      orderId,
    });
  }

  return { fills, resolvedOrderIds, unexplained };
}
