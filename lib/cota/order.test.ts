import { describe, expect, it } from "vitest";
import type { DayState, EnforcedBound } from "./enforce";
import {
  MON_MARKET,
  orderFrame,
  planOpen,
  sizeUnitsFromNotional,
  T_OPEN_LONG,
  bpsToBf,
  toPrice,
  toSize,
  TIF_GTC,
  TIF_IOC,
  TIF_POST_ONLY,} from "./order";

const NOW = 1_760_000_000n;
const bound: EnforcedBound = {
  venue: "perpl",
  markets: ["MON"],
  maxNotionalUsdE6: 10_000_000n, // $10
  maxLeverageX100: 300n, // 3x
  maxDailyLossUsdE6: 50_000_000n,
  maxTradesPerDay: 50,
  notBefore: NOW - 100n,
  notAfter: NOW + 100_000n,
  revokedAt: null,
};
const freshDay: DayState = {
  tradesToday: 0,
  lossTodayUsdE6: 0n,
  openNotionalUsdE6: 0n,
};

describe("order sizing + scaling", () => {
  it("floors size to whole MON units (never over the target)", () => {
    // $3 at $0.026367 = 113.78 units -> 113, exactly the live fill.
    expect(sizeUnitsFromNotional(3, 0.026367, 0)).toBe(113);
    // $1 at $0.026 = 38.4 -> 38, the size the $1 order actually sent.
    expect(sizeUnitsFromNotional(1, 0.026, 0)).toBe(38);
  });

  it("scales price to 6dp and size to whole units", () => {
    expect(toPrice(MON_MARKET, 0.026411)).toBe(26411);
    expect(toSize(MON_MARKET, 113)).toBe(113);
  });

  it("maps 2 bps to the venue's per-100k unit", () => {
    expect(bpsToBf(2)).toBe(20);
  });
});

describe("planOpen — sizing feeds the leash gate", () => {
  it("accepts an in-bounds $3 long and computes the real order", () => {
    const p = planOpen({
      bound,
      state: freshDay,
      market: MON_MARKET,
      side: "long",
      targetNotionalUsd: 3,
      markPriceUsd: 0.026367,
      leverageX: 1,
      nowSeconds: NOW,
    });
    expect(p.decision.ok).toBe(true);
    expect(p.sizeUnits).toBe(113);
    expect(p.orderType).toBe(T_OPEN_LONG);
    expect(p.order.leverageX100).toBe(100n);
  });

  it("REJECTS a target that would breach the notional cap", () => {
    // $20 target > $10 leash cap.
    const p = planOpen({
      bound,
      state: freshDay,
      market: MON_MARKET,
      side: "long",
      targetNotionalUsd: 20,
      markPriceUsd: 0.026367,
      leverageX: 1,
      nowSeconds: NOW,
    });
    expect(p.decision).toEqual({ ok: false, reason: "notional_exceeded" });
  });

  it("REJECTS leverage over the cap", () => {
    const p = planOpen({
      bound,
      state: freshDay,
      market: MON_MARKET,
      side: "long",
      targetNotionalUsd: 3,
      markPriceUsd: 0.026367,
      leverageX: 5, // > 3x cap
      nowSeconds: NOW,
    });
    expect(p.decision).toEqual({ ok: false, reason: "leverage_exceeded" });
  });

  it("REJECTS a market the leash never named", () => {
    const p = planOpen({
      bound,
      state: freshDay,
      market: { id: 1, symbol: "BTC", priceDecimals: 6, sizeDecimals: 3 },
      side: "long",
      targetNotionalUsd: 3,
      markPriceUsd: 60000,
      leverageX: 1,
      nowSeconds: NOW,
    });
    expect(p.decision).toEqual({ ok: false, reason: "market_not_authorised" });
  });
});

describe("orderFrame — matches the live wire frame", () => {
  it("builds the exact frame that filled on mainnet", () => {
    // HISTORICAL TRACE. This frame, fl:0 and all, was accepted and filled on
    // account 5103. It is kept verbatim as evidence of what the venue takes —
    // so `flags` is passed explicitly rather than relying on the default, which
    // is now IOC for a market order to stop a residual resting past the leash
    // check. Do not "fix" the fl:0 here: it is a record, not a preference.
    const frame = orderFrame({
      sn: 1,
      rq: 1,
      market: MON_MARKET,
      accountId: 5103,
      orderType: T_OPEN_LONG,
      sizeUnits: 113,
      leverageX: 1,
      feeBps: 2,
      flags: TIF_GTC,
    });
    expect(frame).toEqual({
      mt: 22,
      sn: 1,
      rq: 1,
      mkt: 10,
      acc: 5103,
      t: 1,
      p: 0, // market order
      s: 113,
      fl: 0,
      lv: 100,
      lb: 0,
      bf: 20,
    });
  });
});

describe("orderFrame — time in force", () => {
  const base = {
    sn: 1,
    rq: 1,
    market: MON_MARKET,
    accountId: 5273,
    orderType: T_OPEN_LONG,
    sizeUnits: 131,
    leverageX: 2,
    feeBps: 2,
  };

  it("a market order is IOC, like the venue's own builder", () => {
    // Perpl's bundle: orderType === market ? fl |= sq, and sq is 4.
    expect(orderFrame(base).fl).toBe(TIF_IOC);
    expect(orderFrame({ ...base, priceUsd: 0 }).fl).toBe(TIF_IOC);
  });

  it("a limit order is GTC", () => {
    expect(orderFrame({ ...base, priceUsd: 0.023 }).fl).toBe(TIF_GTC);
  });

  it("never leaves a market residual resting by default", () => {
    // The regression that matters: fl 0 on a market order lets the unfilled
    // remainder sit on the book and fill after the leash was evaluated.
    expect(orderFrame(base).fl).not.toBe(TIF_GTC);
  });

  it("an explicit flags argument still wins", () => {
    expect(orderFrame({ ...base, flags: TIF_POST_ONLY }).fl).toBe(
      TIF_POST_ONLY,
    );
  });
});
