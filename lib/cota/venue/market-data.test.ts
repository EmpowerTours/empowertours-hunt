import { describe, expect, it } from "vitest";
import { markFromFrame, quoteFromContext } from "./market-data";

// A real-shaped market-state frame (mt 9): the chain-wide stream carries every
// market under `d`, keyed by market id (string), each with a scaled `mrk`.
const FRAME = {
  mt: 9,
  d: {
    "10": { mrk: 26411, mid: 26400, bid: 26390, ask: 26420, lst: 26405 }, // MON
    "1": { mrk: 60123450000, mid: 60123000000 }, // BTC-ish, different scale
  },
};

describe("markFromFrame", () => {
  it("reads MON's mark and scales by price_decimals (6dp)", () => {
    // 26411 / 1e6 = $0.026411 — the price the live $3 fill printed.
    expect(markFromFrame(FRAME, 10, 6)).toBeCloseTo(0.026411, 9);
  });

  it("scales a different market by its own decimals", () => {
    expect(markFromFrame(FRAME, 1, 6)).toBeCloseTo(60123.45, 6);
  });

  it("returns null for a non-market-state frame", () => {
    expect(markFromFrame({ mt: 100 }, 10, 6)).toBeNull(); // heartbeat
  });

  it("returns null when the frame doesn't carry that market", () => {
    expect(markFromFrame(FRAME, 999, 6)).toBeNull();
  });

  it("returns null on a zero/absent mark rather than a bogus 0 price", () => {
    expect(markFromFrame({ mt: 9, d: { "10": { mrk: 0 } } }, 10, 6)).toBeNull();
    expect(markFromFrame({ mt: 9, d: { "10": {} } }, 10, 6)).toBeNull();
    expect(markFromFrame({ mt: 9, d: { "10": null } }, 10, 6)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The real MON entry from Perpl's public context endpoint, 2026-09-29. Kept
// verbatim because the field names are the whole risk: `mrk`/`bid`/`ask` are
// undocumented three-letter keys and a rename upstream must fail loudly here
// rather than quietly price somebody's order off a missing field.
// ---------------------------------------------------------------------------
const CONTEXT_MON = {
  markets: [
    { id: 9, state: { mrk: 1, bid: 1, ask: 1 } },
    {
      id: 10,
      name: "MON",
      config: { price_decimals: 6 },
      state: {
        orl: 27107,
        mrk: 27131,
        lst: 27173,
        mid: 27224,
        bid: 27189,
        ask: 27260,
      },
    },
  ],
};

describe("quoteFromContext", () => {
  it("reads all three off one payload, descaled", () => {
    const q = quoteFromContext(CONTEXT_MON, 10, 6)!;
    expect(q.markUsd).toBeCloseTo(0.027131, 9);
    expect(q.bidUsd).toBeCloseTo(0.027189, 9);
    expect(q.askUsd).toBeCloseTo(0.02726, 9);
  });

  it("does not assume the mark lies inside the book", () => {
    // It did not, on the day this was recorded. Any code that 'corrects' a mark
    // below the bid would be inventing a price the venue never published.
    const q = quoteFromContext(CONTEXT_MON, 10, 6)!;
    expect(q.markUsd).toBeLessThan(q.bidUsd!);
  });

  it("returns null for a market the payload does not carry", () => {
    expect(quoteFromContext(CONTEXT_MON, 999, 6)).toBeNull();
    expect(quoteFromContext({}, 10, 6)).toBeNull();
    expect(quoteFromContext(null, 10, 6)).toBeNull();
  });

  it("nulls a missing or nonsensical side rather than defaulting it", () => {
    const q = quoteFromContext(
      { markets: [{ id: 10, state: { mrk: 27131, bid: 0 } }] },
      10,
      6,
    )!;
    expect(q.markUsd).toBeCloseTo(0.027131, 9);
    expect(q.bidUsd).toBeNull();
    expect(q.askUsd).toBeNull();
  });
});
