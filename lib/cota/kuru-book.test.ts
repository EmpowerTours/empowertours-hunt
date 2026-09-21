import { describe, expect, it } from "vitest";
import { depthUsd, parseBook } from "./kuru-book";

// ---------------------------------------------------------------------------
// Rows taken verbatim from https://exchange.kuru.io/api/v3/depth?symbol=MON_USDC
// on 2026-09-20. They are here because the two fields use DIFFERENT fixed-point
// scales — price 1e18, size 1e10 — and nothing in the response says so.
//
// The failure that matters is silent: read the size as 1e18 and a $254 level
// becomes 0.00001 MON. The book looks empty when it is deep, and a trader
// refuses an order they should have taken. No exception, no warning, just a
// wrong number in the direction that loses the trade.
// ---------------------------------------------------------------------------

const REAL = {
  lastUpdateId: 106606611,
  bids: [
    ["25371000000000000", "100140000000000"],
    ["25358000000000000", "196000000000000"],
  ],
  asks: [
    ["25382000000000000", "196000000000000"],
    ["25387000000000000", "196850000000000"],
  ],
};

describe("parseBook", () => {
  it("applies the two scales separately", () => {
    const b = parseBook(REAL);
    expect(b.bestBidUsd).toBeCloseTo(0.025371, 9);
    expect(b.bestAskUsd).toBeCloseTo(0.025382, 9);
    // 100140000000000 / 1e10 = 10,014 MON. Read at 1e18 this would be 0.0001.
    expect(b.bids[0].sizeMon).toBeCloseTo(10014, 6);
    expect(b.bids[0].notionalUsd).toBeCloseTo(10014 * 0.025371, 6);
  });

  it("computes a spread a trader can act on", () => {
    // (0.025382 - 0.025371) / mid ≈ 4.3 bps — Kuru's book is tight, and that
    // tightness is the entire reason it is worth using as a reference.
    expect(parseBook(REAL).spreadBps).toBeCloseTo(4.3, 1);
  });

  it("orders bids high-first and asks low-first", () => {
    // Fed in backwards on purpose: an unsorted book reports a NEGATIVE spread,
    // which reads as free money.
    const b = parseBook({
      bids: [...REAL.bids].reverse(),
      asks: [...REAL.asks].reverse(),
    });
    expect(b.bids[0].priceUsd).toBeGreaterThan(b.bids[1].priceUsd);
    expect(b.asks[0].priceUsd).toBeLessThan(b.asks[1].priceUsd);
    expect(b.spreadBps as number).toBeGreaterThan(0);
  });

  it("drops levels it cannot read rather than pricing them at zero", () => {
    const b = parseBook({
      bids: [
        ["0", "100"],
        ["notanumber", "100"],
        REAL.bids[0],
        ["25000000000000000", "0"],
      ],
      asks: REAL.asks,
    });
    expect(b.bids).toHaveLength(1);
    expect(b.bids[0].priceUsd).toBeCloseTo(0.025371, 9);
  });

  it("survives an empty or malformed body without throwing", () => {
    for (const body of [
      {},
      { bids: null, asks: null },
      { bids: [], asks: [] },
    ]) {
      const b = parseBook(body);
      expect(b.bestBidUsd).toBeNull();
      expect(b.bestAskUsd).toBeNull();
      expect(b.spreadBps).toBeNull();
    }
  });
});

describe("depthUsd", () => {
  it("sums what the side is worth, not how many levels it has", () => {
    const b = parseBook(REAL);
    const expected = 10014 * 0.025371 + 19600 * 0.025358;
    expect(depthUsd(b.bids)).toBeCloseTo(expected, 4);
  });

  it("is zero on an empty side", () => {
    expect(depthUsd([])).toBe(0);
  });
});
