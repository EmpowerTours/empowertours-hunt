import { describe, expect, it } from "vitest";
import {
  foldFills,
  unrealisedUsd,
  realizedTodayUsd,
  countOrdersToday,
  lossTodayUsdE6,
  type LedgerFill,
} from "./pnl";
import { MON_MARKET, type Market } from "../order";
import { USD_SCALE, type MarkedMarket } from "./account-state";

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

const marks = (markUsd: number, market: Market = MON_MARKET) =>
  new Map<number, MarkedMarket>([[market.id, { market, markUsd }]]);

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

describe("unrealisedUsd", () => {
  it("long gains as the mark rises", () => {
    const { positions } = foldFills([fill({ priceUsd: 0.02 })]);
    expect(unrealisedUsd(positions, marks(0.025))).toBeCloseTo(0.5, 9); // 100×0.005
  });

  it("short gains as the mark falls", () => {
    const { positions } = foldFills([fill({ direction: -1, priceUsd: 0.05 })]);
    expect(unrealisedUsd(positions, marks(0.04))).toBeCloseTo(1.0, 9); // −100×(0.04−0.05)
  });

  it("throws on a held market with no mark", () => {
    const { positions } = foldFills([fill({ marketId: 99 })]);
    expect(() => unrealisedUsd(positions, marks(0.02))).toThrow(
      /no mark for held market 99/,
    );
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
    expect(countOrdersToday(fills, T0 + 2000)).toBe(2); // orders 2 and 3
  });
});

describe("lossTodayUsdE6 — the number the daily-loss stop gates on", () => {
  it("reports a down day as a positive E6 magnitude (unrealised loss)", () => {
    // long 100 @ 0.05, mark now 0.02 → unrealised −3.0
    const fills = [fill({ direction: 1, sizeUnits: 100, priceUsd: 0.05 })];
    expect(lossTodayUsdE6(fills, marks(0.02), T0)).toBe(BigInt(3 * USD_SCALE));
  });

  it("reports zero on an up day — no negative headroom", () => {
    const fills = [fill({ direction: 1, sizeUnits: 100, priceUsd: 0.02 })];
    expect(lossTodayUsdE6(fills, marks(0.05), T0)).toBe(0n); // unrealised +3.0
  });

  it("fees alone push a flat day into loss", () => {
    const fills = [fill({ priceUsd: 0.02, feeUsd: 0.5 })];
    // flat mark → unrealised 0, realised today −0.5
    expect(lossTodayUsdE6(fills, marks(0.02), T0)).toBe(
      BigInt(0.5 * USD_SCALE),
    );
  });
});
