import { describe, expect, it } from "vitest";
import { parsePositions } from "./frames";
import {
  describePositions,
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
