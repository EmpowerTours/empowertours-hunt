import { describe, expect, it } from "vitest";
import { markFromFrame } from "./market-data";

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
