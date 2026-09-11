import { describe, expect, it } from "vitest";
import { parsePositions } from "./frames";
import {
  openNotionalUsdE6,
  toDayState,
  USD_SCALE,
  type MarkedMarket,
} from "./account-state";
import { MON_MARKET, type Market } from "../order";

// A second market that scales size, to prove descaling isn't MON's 0-decimals
// by accident.
const KMKT: Market = {
  id: 20,
  symbol: "K",
  priceDecimals: 6,
  sizeDecimals: 2,
};

describe("parsePositions — mt 26/27, open only", () => {
  it("parses a snapshot (mt 26) of open positions", () => {
    const out = parsePositions({
      mt: 26,
      d: [{ pid: 7, mkt: 10, sd: 1, st: 1, lv: 500, s: 116 }],
    });
    expect(out).toEqual([
      { pid: 7, marketId: 10, side: 1, sizeScaled: 116, leverageX100: 500 },
    ]);
  });

  it("parses an update (mt 27) the same way", () => {
    const out = parsePositions({
      mt: 27,
      d: [{ pid: 8, mkt: 20, sd: 2, st: 1, lv: 300, s: 500 }],
    });
    expect(out[0]).toMatchObject({ pid: 8, marketId: 20, side: 2 });
  });

  it("drops non-open (closed/liquidated) positions — st !== PS_OPEN", () => {
    const out = parsePositions({
      mt: 27,
      d: [
        { pid: 1, mkt: 10, sd: 1, st: 1, lv: 100, s: 10 },
        { pid: 2, mkt: 10, sd: 1, st: 2, lv: 100, s: 10 }, // closed
      ],
    });
    expect(out.map((p) => p.pid)).toEqual([1]);
  });

  it("returns [] on the wrong message type or a missing d", () => {
    expect(parsePositions({ mt: 19, as: [] })).toEqual([]);
    expect(parsePositions({ mt: 26 })).toEqual([]);
    expect(parsePositions(null)).toEqual([]);
  });
});

describe("openNotionalUsdE6 — Σ |size| × mark", () => {
  const marks = new Map<number, MarkedMarket>([
    [10, { market: MON_MARKET, markUsd: 0.025 }], // sizeDecimals 0
    [20, { market: KMKT, markUsd: 2.0 }], // sizeDecimals 2
  ]);

  it("prices a single MON long (sizeDecimals 0)", () => {
    const n = openNotionalUsdE6(
      [{ pid: 1, marketId: 10, side: 1, sizeScaled: 100, leverageX100: 100 }],
      marks,
    );
    // 100 units × $0.025 = $2.50
    expect(n).toBe(BigInt(2.5 * USD_SCALE));
  });

  it("counts a short the same as a long — side is irrelevant to notional", () => {
    const long = openNotionalUsdE6(
      [{ pid: 1, marketId: 10, side: 1, sizeScaled: 100, leverageX100: 100 }],
      marks,
    );
    const short = openNotionalUsdE6(
      [{ pid: 2, marketId: 10, side: 2, sizeScaled: 100, leverageX100: 100 }],
      marks,
    );
    expect(short).toBe(long);
  });

  it("descales size by the market's size_decimals and sums markets", () => {
    const n = openNotionalUsdE6(
      [
        { pid: 1, marketId: 10, side: 1, sizeScaled: 100, leverageX100: 100 }, // $2.50
        { pid: 2, marketId: 20, side: 1, sizeScaled: 500, leverageX100: 100 }, // 5.00 units × $2 = $10
      ],
      marks,
    );
    expect(n).toBe(BigInt(12.5 * USD_SCALE));
  });

  it("throws on a held market with no mark rather than under-report the cap", () => {
    expect(() =>
      openNotionalUsdE6(
        [{ pid: 1, marketId: 99, side: 1, sizeScaled: 1, leverageX100: 100 }],
        marks,
      ),
    ).toThrow(/no mark for held market 99/);
  });

  it("empty positions is zero", () => {
    expect(openNotionalUsdE6([], marks)).toBe(0n);
  });
});

describe("toDayState — fail closed on unread loss", () => {
  it("returns null when lossTodayUsdE6 is null (not a zeroed DayState)", () => {
    expect(
      toDayState({
        openNotionalUsdE6: 5_000_000n,
        tradesToday: 2,
        lossTodayUsdE6: null,
      }),
    ).toBeNull();
  });

  it("builds a DayState when loss is known", () => {
    expect(
      toDayState({
        openNotionalUsdE6: 5_000_000n,
        tradesToday: 2,
        lossTodayUsdE6: 1_000_000n,
      }),
    ).toEqual({
      openNotionalUsdE6: 5_000_000n,
      tradesToday: 2,
      lossTodayUsdE6: 1_000_000n,
    });
  });
});
