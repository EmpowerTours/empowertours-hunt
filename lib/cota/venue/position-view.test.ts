import { describe, expect, it } from "vitest";
import { parsePositions } from "./frames";
import {
  describePositions,
  addBlockedByLoss,
  lossBpsOfCollateral,
  opensAgainst,
  type PositionView,
} from "./position-view";

describe("describePositions", () => {
  it("reads account 5273's real first fill: MON long 214 at 2x from 0.023308", () => {
    // The mt 26 frame pinned verbatim in frames.test.ts (2026-09-14).
    const frames = parsePositions({
      mt: 26,
      d: [
        {
          mkt: 10,
          pid: 6870209921025,
          st: 1,
          sd: 1,
          s: 214,
          ep: 23308,
          c: "2504014",
          fee: "4440",
          lv: 200,
          cpnl: "0",
          dpnl: "0",
        },
      ],
    });
    expect(describePositions(frames)).toEqual([
      {
        pid: 6870209921025,
        market: "MON",
        side: "long",
        size: 214,
        scaled: true,
        leverageX: 2,
        entryUsd: 0.023308,
      },
    ]);
  });

  it("does not pretend to know the scale of a market it does not pin", () => {
    const [p] = describePositions([
      {
        pid: 1,
        marketId: 99,
        side: 2,
        sizeScaled: 5000,
        leverageX100: 300,
        entryPriceScaled: 123,
        feeScaled: null,
      } as never,
    ]);
    expect(p).toMatchObject({
      market: "#99",
      side: "short",
      size: 5000,
      scaled: false,
      leverageX: 3,
    });
  });
});

// The position the 2026-10-31 refusal log carried, and the account beside it.
const LIVE_LONG: PositionView = {
  pid: 7399932231682,
  market: "MON",
  side: "long",
  size: 395,
  scaled: true,
  leverageX: 1,
  entryUsd: 0.02466,
};

describe("lossBpsOfCollateral", () => {
  it("puts the live 395 MON long at about 22% down", () => {
    // Mark 0.019296 on the 2026-10-31 refusal log: (0.02466 − 0.019296) × 395
    // = $2.1188 against 395 × 0.02466 = $9.7407 of collateral.
    expect(lossBpsOfCollateral(LIVE_LONG, 0.019296)).toBe(2175);
  });
  it("is zero for a position in profit", () => {
    expect(lossBpsOfCollateral(LIVE_LONG, 0.03)).toBe(0);
  });
  it("scales with leverage: the same move is twice the loss at 2x", () => {
    const at1 = lossBpsOfCollateral(LIVE_LONG, 0.0239)!;
    const at2 = lossBpsOfCollateral({ ...LIVE_LONG, leverageX: 2 }, 0.0239)!;
    expect(at2).toBeCloseTo(at1 * 2, -1);
  });
  it("measures a short's loss upward", () => {
    expect(
      lossBpsOfCollateral({ ...LIVE_LONG, side: "short" }, 0.02466 * 1.05),
    ).toBe(500);
  });
  it("cannot price a raw or entry-less position", () => {
    expect(
      lossBpsOfCollateral({ ...LIVE_LONG, scaled: false }, 0.02),
    ).toBeNull();
    expect(
      lossBpsOfCollateral({ ...LIVE_LONG, entryUsd: null }, 0.02),
    ).toBeNull();
  });
});

describe("addBlockedByLoss", () => {
  const live = { positions: [LIVE_LONG], market: "MON", limitBps: 300 };
  it("blocks adding to the live long at Perpl's 300 bps", () => {
    expect(addBlockedByLoss({ ...live, markUsd: 0.019296 })).toEqual({
      blocked: true,
      lossBps: 2175,
      limitBps: 300,
    });
  });
  it("lets it through once the loss is back inside the limit", () => {
    expect(addBlockedByLoss({ ...live, markUsd: 0.0241 })).toEqual({
      blocked: false,
    });
  });
  it("has nothing to say when nothing is open on that market", () => {
    expect(
      addBlockedByLoss({
        ...live,
        positions: [],
        markUsd: null,
        limitBps: null,
      }),
    ).toEqual({ blocked: false });
  });
  it("is unknown, not clear, without a mark or a limit", () => {
    expect(addBlockedByLoss({ ...live, markUsd: null })).toEqual({
      blocked: "unknown",
    });
    expect(
      addBlockedByLoss({ ...live, markUsd: 0.02, limitBps: null }),
    ).toEqual({ blocked: "unknown" });
  });
});

describe("opensAgainst", () => {
  it("lets a long add to a long", () => {
    expect(opensAgainst([LIVE_LONG], "MON", "long")).toBe(false);
  });
  it("refuses a short against a long", () => {
    expect(opensAgainst([LIVE_LONG], "MON", "short")).toBe(true);
  });
  it("refuses against a side it cannot read", () => {
    expect(
      opensAgainst([{ ...LIVE_LONG, side: "unknown" }], "MON", "long"),
    ).toBe(true);
  });
  it("ignores other markets", () => {
    expect(
      opensAgainst([{ ...LIVE_LONG, market: "BTC" }], "MON", "short"),
    ).toBe(false);
  });
});
