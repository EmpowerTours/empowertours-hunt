import { describe, expect, it } from "vitest";
import {
  foldSpot,
  monText,
  usdText,
  withinPeriod,
  type SpotTrade,
} from "./spot-pnl";

const WEI = 10n ** 18n;
const USDC = "0x754704bc059f8c67012fed69bc8a327a5aafb603";

const trade = (
  o: Omit<Partial<SpotTrade>, "at"> & { side: string; at: string },
): SpotTrade => ({
  hash: o.hash ?? `0x${o.at}`,
  side: o.side,
  ok: o.ok ?? true,
  valueWei: o.valueWei ?? "0",
  nativeInWei: o.nativeInWei ?? null,
  tokensIn: o.tokensIn ?? {},
  tokensOut: o.tokensOut ?? {},
  gasWei: o.gasWei ?? "0",
  at: new Date(o.at),
});

// ---------------------------------------------------------------------------
// Pinned to the real round trip of 4 October 2026.
//
//   18:14  sold   1,629.327934276 MON  ->  58.4964 USDC
//   19:35  bought 1,734.7097     MON  <-  58.4964 USDC
//
// +105.38 MON and exactly $0.00, which is the whole reason this reports both.
// ---------------------------------------------------------------------------

const SOLD = 1_629_327_934_276_000_000_000n;
const BOUGHT = 1_734_709_700_000_000_000_000n;
const DOLLARS = 58_496_400n;

describe("foldSpot — the real round trip", () => {
  const sell = trade({
    side: "sell",
    at: "2026-10-04T18:14:49Z",
    valueWei: SOLD.toString(),
    tokensIn: { [USDC]: DOLLARS.toString() },
    gasWei: 39_492_156_000_000_000n.toString(),
  });
  const buy = trade({
    side: "buy",
    at: "2026-10-04T19:35:10Z",
    nativeInWei: BOUGHT.toString(),
    tokensOut: { [USDC]: DOLLARS.toString() },
    gasWei: 9_000_000_000_000_000n.toString(),
  });

  it("reports more MON and no dollars, which are both true", () => {
    const r = foldSpot([sell, buy]);
    expect(r.netMonWei).toBe(BOUGHT - SOLD);
    expect(monText(r.netMonWei)).toBe("105.38");
  });

  it("holds the bought MON open with what it cost", () => {
    const r = foldSpot([sell, buy]);
    // The buy came last, so nothing has been sold against it yet.
    expect(r.openMonWei).toBe(BOUGHT);
    expect(r.openBasis6).toBe(DOLLARS);
    expect(usdText(r.openBasis6)).toBe("58.49");
  });

  it("counts the gas of both trades", () => {
    const r = foldSpot([sell, buy]);
    expect(r.gasWei).toBe(39_492_156_000_000_000n + 9_000_000_000_000_000n);
  });

  it("orders by time, not by the order it was handed them", () => {
    // The backfilled sell was written AFTER the buy, so a fold that trusted
    // insertion order would match the round trip backwards.
    const forwards = foldSpot([sell, buy]);
    const backwards = foldSpot([buy, sell]);
    expect(backwards.netMonWei).toBe(forwards.netMonWei);
    expect(backwards.openMonWei).toBe(forwards.openMonWei);
  });
});

describe("foldSpot — FIFO picks the oldest lot", () => {
  const buyAt = (at: string, mon: bigint, cost6: bigint) =>
    trade({
      side: "buy",
      at,
      nativeInWei: mon.toString(),
      tokensOut: { [USDC]: cost6.toString() },
    });

  it("subtracts the FIRST purchase price, not the cheapest or the latest", () => {
    // 1,000 MON at $30, then 1,000 at $40, then sell 1,000 for $50.
    // FIFO subtracts $30 and realises $20. LIFO would say $10, average $15.
    const r = foldSpot([
      buyAt("2026-01-01T00:00:00Z", 1_000n * WEI, 30_000_000n),
      buyAt("2026-01-02T00:00:00Z", 1_000n * WEI, 40_000_000n),
      trade({
        side: "sell",
        at: "2026-01-03T00:00:00Z",
        valueWei: (1_000n * WEI).toString(),
        tokensIn: { [USDC]: 50_000_000n.toString() },
      }),
    ]);
    expect(r.disposals).toHaveLength(1);
    expect(usdText(r.disposals[0].basis6)).toBe("30.00");
    expect(usdText(r.realised6)).toBe("20.00");
    // The $40 lot is still open.
    expect(r.openMonWei).toBe(1_000n * WEI);
    expect(usdText(r.openBasis6)).toBe("40.00");
  });

  it("splits a lot when a sell is smaller than it", () => {
    const r = foldSpot([
      buyAt("2026-01-01T00:00:00Z", 1_000n * WEI, 30_000_000n),
      trade({
        side: "sell",
        at: "2026-01-02T00:00:00Z",
        valueWei: (400n * WEI).toString(),
        tokensIn: { [USDC]: 20_000_000n.toString() },
      }),
    ]);
    // 40% of a $30 lot is $12 of basis against $20 of proceeds.
    expect(usdText(r.disposals[0].basis6)).toBe("12.00");
    expect(usdText(r.realised6)).toBe("8.00");
    expect(r.openMonWei).toBe(600n * WEI);
    expect(usdText(r.openBasis6)).toBe("18.00");
  });

  it("spans two lots when a sell is bigger than the first", () => {
    const r = foldSpot([
      buyAt("2026-01-01T00:00:00Z", 1_000n * WEI, 30_000_000n),
      buyAt("2026-01-02T00:00:00Z", 1_000n * WEI, 40_000_000n),
      trade({
        side: "sell",
        at: "2026-01-03T00:00:00Z",
        valueWei: (1_500n * WEI).toString(),
        tokensIn: { [USDC]: 90_000_000n.toString() },
      }),
    ]);
    // All of the $30 lot plus half the $40 one = $50 of basis.
    expect(usdText(r.disposals[0].basis6)).toBe("50.00");
    expect(usdText(r.realised6)).toBe("40.00");
    expect(r.openMonWei).toBe(500n * WEI);
  });

  it("reports a loss as a loss", () => {
    const r = foldSpot([
      buyAt("2026-01-01T00:00:00Z", 1_000n * WEI, 50_000_000n),
      trade({
        side: "sell",
        at: "2026-01-02T00:00:00Z",
        valueWei: (1_000n * WEI).toString(),
        tokensIn: { [USDC]: 30_000_000n.toString() },
      }),
    ]);
    expect(r.realised6).toBeLessThan(0n);
    expect(usdText(r.realised6)).toBe("-20.00");
  });
});

describe("foldSpot — what it refuses to invent", () => {
  it("drops a reverted trade but keeps the gas it burned", () => {
    const r = foldSpot([
      trade({
        side: "sell",
        at: "2026-01-01T00:00:00Z",
        ok: false,
        valueWei: (999n * WEI).toString(),
        gasWei: ((5n * WEI) / 100n).toString(),
      }),
    ]);
    // It moved no MON...
    expect(r.netMonWei).toBe(0n);
    expect(r.disposals).toHaveLength(0);
    // ...but it really cost the full gas limit, and a result that hid the price
    // of failure would flatter whatever produced it.
    expect(r.gasWei).toBe((5n * WEI) / 100n);
  });

  it("counts a buy whose MON amount was never established, and prices nothing", () => {
    const r = foldSpot([
      trade({ side: "buy", at: "2026-01-01T00:00:00Z", nativeInWei: null }),
    ]);
    expect(r.unpriced).toBe(1);
    expect(r.openMonWei).toBe(0n);
    expect(r.netMonWei).toBe(0n);
  });

  it("realises nothing on a sell with no lot behind it", () => {
    // MON earned by hunting, not bought. There is no purchase price, so the
    // proceeds are all realised — which is correct, and the basis is zero
    // because it genuinely cost nothing to acquire.
    const r = foldSpot([
      trade({
        side: "sell",
        at: "2026-01-01T00:00:00Z",
        valueWei: (100n * WEI).toString(),
        tokensIn: { [USDC]: 5_000_000n.toString() },
      }),
    ]);
    expect(usdText(r.disposals[0].basis6)).toBe("0.00");
    expect(usdText(r.realised6)).toBe("5.00");
  });
});

describe("text helpers", () => {
  it("formats both units without inventing precision", () => {
    expect(monText(0n)).toBe("0.00");
    expect(monText(WEI)).toBe("1.00");
    expect(monText(-WEI)).toBe("-1.00");
    expect(usdText(58_496_400n)).toBe("58.49");
    expect(usdText(-20_000_000n)).toBe("-20.00");
  });
});

describe("withinPeriod", () => {
  const NOW = new Date("2026-10-04T20:00:00Z").getTime();
  const at = (iso: string) => trade({ side: "sell", at: iso });
  const trades = [
    at("2026-10-04T18:00:00Z"), // 2 hours ago
    at("2026-10-01T12:00:00Z"), // 3 days
    at("2026-09-20T12:00:00Z"), // 14 days
    at("2026-08-01T12:00:00Z"), // 64 days
  ];

  it("keeps only what falls inside the window", () => {
    expect(withinPeriod(trades, "day", NOW)).toHaveLength(1);
    expect(withinPeriod(trades, "week", NOW)).toHaveLength(2);
    expect(withinPeriod(trades, "month", NOW)).toHaveLength(3);
    expect(withinPeriod(trades, "all", NOW)).toHaveLength(4);
  });

  it("filters BEFORE the fold, so a window is what the window did", () => {
    // Bought in January, sold in October. Over "all" the basis is the January
    // purchase and almost nothing is realised. Over "day" the purchase is
    // outside the window, so the sale shows its full proceeds — which is the
    // honest answer to "what did today do", and deliberately not a slice of
    // the lifetime figure.
    const all: SpotTrade[] = [
      trade({
        side: "buy",
        at: "2026-01-01T00:00:00Z",
        nativeInWei: (100n * WEI).toString(),
        tokensOut: { [USDC]: 9_000_000n.toString() },
      }),
      trade({
        side: "sell",
        at: "2026-10-04T18:00:00Z",
        valueWei: (100n * WEI).toString(),
        tokensIn: { [USDC]: 10_000_000n.toString() },
      }),
    ];
    expect(usdText(foldSpot(all).realised6)).toBe("1.00");
    expect(usdText(foldSpot(withinPeriod(all, "day", NOW)).realised6)).toBe(
      "10.00",
    );
  });
});
