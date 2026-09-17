import { describe, expect, it } from "vitest";
import { postOnlyPrice } from "./post-only-price";
import { MON_MARKET } from "./order";

// MON: price_decimals 6, so one tick is 0.000001.
const TICK = 1e-6;
// The real touch on Perpl's MON market: bid 21474 / ask 21526 scaled by 1e6.
const BID = 0.021474;
const ASK = 0.021526;

describe("resting inside the touch", () => {
  it("a buy rests one tick ABOVE the bid", () => {
    const q = postOnlyPrice(MON_MARKET, "long", { bidUsd: BID, askUsd: ASK });
    expect(q?.priceUsd).toBeCloseTo(BID + TICK, 12);
    expect(q?.insideTicks).toBe(1);
  });

  it("a sell rests one tick BELOW the ask", () => {
    const q = postOnlyPrice(MON_MARKET, "short", { bidUsd: BID, askUsd: ASK });
    expect(q?.priceUsd).toBeCloseTo(ASK - TICK, 12);
    expect(q?.insideTicks).toBe(1);
  });

  it("never rests on the wrong side of the book", () => {
    // A buy priced at or above the ask would cross, and a post-only order that
    // crosses is REJECTED, not filled — a wasted request every block.
    const buy = postOnlyPrice(MON_MARKET, "long", { bidUsd: BID, askUsd: ASK });
    const sell = postOnlyPrice(MON_MARKET, "short", {
      bidUsd: BID,
      askUsd: ASK,
    });
    expect(buy!.priceUsd).toBeLessThan(ASK);
    expect(sell!.priceUsd).toBeGreaterThan(BID);
  });
});

describe("a spread too tight to improve", () => {
  it("joins the touch rather than crossing it", () => {
    const tight = { bidUsd: 0.021474, askUsd: 0.021475 }; // one tick apart
    const buy = postOnlyPrice(MON_MARKET, "long", tight);
    expect(buy?.insideTicks).toBe(0);
    expect(buy?.priceUsd).toBeCloseTo(tight.bidUsd, 12);

    const sell = postOnlyPrice(MON_MARKET, "short", tight);
    expect(sell?.insideTicks).toBe(0);
    expect(sell?.priceUsd).toBeCloseTo(tight.askUsd, 12);
  });

  it("still never crosses on a locked book", () => {
    const locked = { bidUsd: 0.021474, askUsd: 0.021474 };
    expect(
      postOnlyPrice(MON_MARKET, "long", locked)!.priceUsd,
    ).toBeLessThanOrEqual(locked.askUsd);
  });
});

describe("refusing rather than guessing", () => {
  it("returns null when our own side is missing", () => {
    expect(
      postOnlyPrice(MON_MARKET, "long", { bidUsd: null, askUsd: ASK }),
    ).toBeNull();
    expect(
      postOnlyPrice(MON_MARKET, "short", { bidUsd: BID, askUsd: null }),
    ).toBeNull();
  });

  it("rests at its own touch when only the far side is missing", () => {
    // We know where to sit; we just cannot tell whether there is room inside.
    const q = postOnlyPrice(MON_MARKET, "long", { bidUsd: BID, askUsd: null });
    expect(q?.priceUsd).toBeCloseTo(BID, 12);
    expect(q?.insideTicks).toBe(0);
  });
});

describe("the price lands on the venue's grid", () => {
  it("is always a whole number of ticks", () => {
    for (const bid of [0.021474, 0.0225317, 0.019999]) {
      for (const side of ["long", "short"] as const) {
        const q = postOnlyPrice(MON_MARKET, side, {
          bidUsd: bid,
          askUsd: bid + 50 * TICK,
        });
        const scaled = q!.priceUsd * 1e6;
        expect(Math.abs(scaled - Math.round(scaled))).toBeLessThan(1e-6);
      }
    }
  });
});
