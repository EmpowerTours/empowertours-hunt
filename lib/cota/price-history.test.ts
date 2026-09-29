import { describe, expect, it, vi } from "vitest";
import {
  downsample,
  fetchPriceHistory,
  hasHistory,
  parseMarketChart,
  summarise,
} from "./price-history";

// ---------------------------------------------------------------------------
// This exists because every Kimi proposal came back "hold". Not a bug in the
// model — it was handed one spot price and told to prefer holding, and one
// number is not a market. These tests guard the distinction the fix rests on:
// "no history" must never render as "a flat market".
// ---------------------------------------------------------------------------

describe("reading CoinGecko", () => {
  it("reads the real shape", () => {
    expect(
      parseMarketChart({
        prices: [
          [1759000000000, 0.028203],
          [1759000300000, 0.028125],
        ],
      }),
    ).toEqual([0.028203, 0.028125]);
  });

  it("drops an unreadable point rather than zeroing it", () => {
    // A zero in a price series is a crash, and a model would try to explain it.
    const out = parseMarketChart({
      prices: [[1, 0.02], [2, 0], [3, null], [4], "nope", [5, 0.03]],
    });
    expect(out).toEqual([0.02, 0.03]);
  });

  it("returns nothing for a response it cannot read", () => {
    expect(parseMarketChart({})).toEqual([]);
    expect(parseMarketChart({ prices: "no" })).toEqual([]);
    expect(parseMarketChart(null)).toEqual([]);
  });
});

describe("reducing a dense series to something a prompt can carry", () => {
  it("keeps the newest point, which is the one a trader reasons from", () => {
    const series = Array.from({ length: 289 }, (_, i) => i);
    const out = downsample(series, 12);
    expect(out).toHaveLength(12);
    expect(out[out.length - 1]).toBe(288);
    expect(out[0]).toBe(0);
  });

  it("leaves a short series alone", () => {
    expect(downsample([1, 2, 3], 12)).toEqual([1, 2, 3]);
  });
});

describe("the summary the model sees", () => {
  it("computes the move across the window", () => {
    const s = summarise([100, 110], 24);
    expect(s.changePct).toBeCloseTo(10);
    expect(s.high).toBe(110);
    expect(s.low).toBe(100);
  });

  it("refuses to invent a percentage from nothing", () => {
    expect(summarise([], 24).changePct).toBeNull();
  });
});

describe("fetching", () => {
  it("returns null for a market we have no id for", async () => {
    const fake = vi.fn() as unknown as typeof fetch;
    expect(await fetchPriceHistory("DOGE", { fetch: fake })).toBeNull();
    expect(fake).not.toHaveBeenCalled();
    expect(hasHistory("MON")).toBe(true);
    expect(hasHistory("DOGE")).toBe(false);
  });

  it("returns null rather than an empty series when the API fails", async () => {
    // The difference is the whole point: null makes the prompt say "no history
    // available", while an empty array would read as a market that never moved.
    const bad = vi.fn(
      async () => new Response("nope", { status: 500 }),
    ) as unknown as typeof fetch;
    expect(await fetchPriceHistory("MON", { fetch: bad })).toBeNull();

    const throws = vi.fn(async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    expect(await fetchPriceHistory("MON", { fetch: throws })).toBeNull();
  });

  it("returns null on a series too short to describe a market", async () => {
    const thin = vi.fn(
      async () => new Response(JSON.stringify({ prices: [[1, 0.02]] })),
    ) as unknown as typeof fetch;
    expect(await fetchPriceHistory("MON", { fetch: thin })).toBeNull();
  });

  it("summarises a good response", async () => {
    const prices = Array.from({ length: 289 }, (_, i) => [
      i,
      0.02 + i / 100000,
    ]);
    const ok = vi.fn(
      async () => new Response(JSON.stringify({ prices })),
    ) as unknown as typeof fetch;
    const h = await fetchPriceHistory("MON", { fetch: ok });
    expect(h!.closes).toHaveLength(12);
    expect(h!.changePct).toBeGreaterThan(0);
    expect(h!.hours).toBe(24);
  });
});
