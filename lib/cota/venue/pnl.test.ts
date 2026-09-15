import { describe, expect, it } from "vitest";
import {
  foldFills,
  realizedTodayUsd,
  countOrdersToday,
  lossTodayUsdE6,
  type LedgerFill,
} from "./pnl";
import { USD_SCALE } from "./account-state";

const T0 = Date.UTC(2026, 8, 10, 20, 0, 0); // 2026-09-10 20:00 UTC — "now"
const YESTERDAY = Date.UTC(2026, 8, 9, 20, 0, 0);

function fill(p: Partial<LedgerFill>): LedgerFill {
  return {
    marketId: 10,
    direction: 1,
    sizeUnits: 100,
    priceUsd: 0.02,
    feeUsd: 0,
    timestampMs: T0,
    orderId: 1,
    ...p,
  };
}


describe("foldFills — positions + realised", () => {
  it("opens a long, no close: one position at the fill price, only fee realised", () => {
    const { positions, realized } = foldFills([
      fill({ direction: 1, sizeUnits: 100, priceUsd: 0.02, feeUsd: 0.01 }),
    ]);
    expect(positions).toEqual([
      { marketId: 10, signedSize: 100, entryUsd: 0.02 },
    ]);
    expect(realized).toEqual([
      { marketId: 10, realizedUsd: -0.01, timestampMs: T0 },
    ]);
  });

  it("VWAPs the entry across two adds", () => {
    const { positions } = foldFills([
      fill({ priceUsd: 0.02, orderId: 1 }),
      fill({ priceUsd: 0.04, orderId: 2 }),
    ]);
    expect(positions[0].signedSize).toBe(200);
    expect(positions[0].entryUsd).toBeCloseTo(0.03, 12);
  });

  it("partial close at a profit: realises the closed portion, keeps entry", () => {
    const { positions, realized } = foldFills([
      fill({ direction: 1, sizeUnits: 100, priceUsd: 0.02, orderId: 1 }),
      fill({ direction: -1, sizeUnits: 40, priceUsd: 0.05, orderId: 2 }),
    ]);
    // 40 × (0.05 − 0.02) = +1.2
    expect(realized[1].realizedUsd).toBeCloseTo(1.2, 9);
    expect(positions[0]).toMatchObject({ signedSize: 60, entryUsd: 0.02 });
  });

  it("full close at a loss: position gone, loss realised", () => {
    const { positions, realized } = foldFills([
      fill({ direction: 1, sizeUnits: 100, priceUsd: 0.05, orderId: 1 }),
      fill({ direction: -1, sizeUnits: 100, priceUsd: 0.02, orderId: 2 }),
    ]);
    expect(positions).toEqual([]);
    expect(realized[1].realizedUsd).toBeCloseTo(-3.0, 9); // 100×(0.02−0.05)
  });

  it("short: sell to open, buy to cover below entry is a profit", () => {
    const { positions, realized } = foldFills([
      fill({ direction: -1, sizeUnits: 100, priceUsd: 0.05, orderId: 1 }),
      fill({ direction: 1, sizeUnits: 100, priceUsd: 0.02, orderId: 2 }),
    ]);
    expect(positions).toEqual([]);
    expect(realized[1].realizedUsd).toBeCloseTo(3.0, 9); // short profits as price falls
  });

  it("flip through zero: realises the old side, opens the remainder at the new price", () => {
    const { positions, realized } = foldFills([
      fill({ direction: 1, sizeUnits: 100, priceUsd: 0.02, orderId: 1 }),
      fill({ direction: -1, sizeUnits: 150, priceUsd: 0.03, orderId: 2 }),
    ]);
    expect(realized[1].realizedUsd).toBeCloseTo(1.0, 9); // close 100 × (0.03−0.02)
    expect(positions[0]).toMatchObject({ signedSize: -50, entryUsd: 0.03 });
  });

  it("sorts out-of-order fills by timestamp before folding", () => {
    const { positions } = foldFills([
      fill({ priceUsd: 0.04, timestampMs: T0 + 1000, orderId: 2 }),
      fill({ priceUsd: 0.02, timestampMs: T0, orderId: 1 }),
    ]);
    expect(positions[0].entryUsd).toBeCloseTo(0.03, 12); // order-independent VWAP
  });
});

describe("realizedTodayUsd / countOrdersToday — UTC day boundary", () => {
  it("counts realised inside the current UTC day only", () => {
    const events = [
      { marketId: 10, realizedUsd: -2, timestampMs: YESTERDAY },
      { marketId: 10, realizedUsd: -1, timestampMs: T0 },
    ];
    expect(realizedTodayUsd(events, T0)).toBeCloseTo(-1, 12);
  });

  it("counts distinct orders today, once each, excluding yesterday", () => {
    const fills = [
      fill({ orderId: 1, timestampMs: YESTERDAY }),
      fill({ orderId: 2, timestampMs: T0 }),
      fill({ orderId: 2, timestampMs: T0 + 500 }), // same order, second fill
      fill({ orderId: 3, timestampMs: T0 + 1000 }),
    ];
    expect(countOrdersToday(fills, [], T0 + 2000)).toBe(2); // orders 2 and 3
  });
});

describe("lossTodayUsdE6 — the number the daily-loss stop gates on", () => {
  // Unrealised is PASSED IN now: the venue's `ep` is the authority on it, so
  // this function no longer rebuilds it from the fold. These cases pin the
  // combination — realised today from the fills, unrealised from the caller.
  it("reports a down day as a positive E6 magnitude (unrealised loss)", () => {
    const fills = [fill({ direction: 1, sizeUnits: 100, priceUsd: 0.05 })];
    expect(lossTodayUsdE6(fills, -3.0, T0)).toBe(BigInt(3 * USD_SCALE));
  });

  it("reports zero on an up day — no negative headroom", () => {
    const fills = [fill({ direction: 1, sizeUnits: 100, priceUsd: 0.02 })];
    expect(lossTodayUsdE6(fills, 3.0, T0)).toBe(0n);
  });

  it("fees alone push a flat day into loss", () => {
    const fills = [fill({ priceUsd: 0.02, feeUsd: 0.5 })];
    expect(lossTodayUsdE6(fills, 0, T0)).toBe(BigInt(0.5 * USD_SCALE));
  });

  it("an unrealised gain can be cancelled by realised fees", () => {
    // The two halves come from different sources; this is the case that breaks
    // if one of them is ever dropped on the floor.
    const fills = [fill({ priceUsd: 0.02, feeUsd: 2.5 })];
    expect(lossTodayUsdE6(fills, 1.0, T0)).toBe(BigInt(1.5 * USD_SCALE));
  });

  it("yesterday's realised loss is not today's", () => {
    const fills = [fill({ priceUsd: 0.02, feeUsd: 9, timestampMs: YESTERDAY })];
    expect(lossTodayUsdE6(fills, 0, T0)).toBe(0n);
  });
});

describe("countOrdersToday — a trade counts when it is SENT", () => {
  const placed = (orderId: number, placedAtMs = T0) => ({
    orderId,
    placedAtMs,
  });

  it("counts an order that was sent and has not filled", () => {
    // THE REGRESSION. Counting fills alone, account 5273 sent nine orders
    // against two fills on 2026-09-15 and the ceiling read two. Every order was
    // gated against a count that did not include the orders already sent.
    expect(countOrdersToday([], [placed(1), placed(2), placed(3)], T0)).toBe(3);
  });

  it("does not double-count an order that later filled", () => {
    // An adopted fill is recorded under the pending order's own orderId, so the
    // union dedupes. Verified against 5273: fill and CotaOrder both carry
    // 293302356.
    const fills = [fill({ orderId: 7, timestampMs: T0 })];
    expect(countOrdersToday(fills, [placed(7)], T0)).toBe(1);
  });

  it("counts a fill with no placed row, and a placed row with no fill", () => {
    const fills = [fill({ orderId: 7, timestampMs: T0 })];
    expect(countOrdersToday(fills, [placed(8)], T0)).toBe(2);
  });

  it("ignores orders placed before today", () => {
    expect(countOrdersToday([], [placed(1, YESTERDAY)], T0)).toBe(0);
  });

  it("is never lower than the fills-only count it replaced", () => {
    // The property that matters: adding placed orders can only tighten the
    // ceiling, never loosen it.
    const fills = [
      fill({ orderId: 1, timestampMs: T0 }),
      fill({ orderId: 2, timestampMs: T0 }),
    ];
    const withPlaced = countOrdersToday(fills, [placed(3), placed(4)], T0);
    const fillsOnly = countOrdersToday(fills, [], T0);
    expect(withPlaced).toBeGreaterThanOrEqual(fillsOnly);
    expect(withPlaced).toBe(4);
  });
});
