import { describe, expect, it } from "vitest";
import { tripsFromFills } from "./trips";
import { foldFills, type LedgerFill } from "./pnl";

const fill = (f: Partial<LedgerFill> & { direction: 1 | -1 }): LedgerFill => ({
  marketId: 1,
  sizeUnits: 100,
  priceUsd: 0.02,
  feeUsd: 0,
  timestampMs: 0,
  orderId: 1,
  ...f,
});

// ---------------------------------------------------------------------------
// The four fills below are REAL. They are the September round trip on account
// 0xe2ab…8395, read out of production, and they are here because they are the
// only evidence this screen has ever had to render. If a refactor changes what
// this trip is worth, it changed history.
// ---------------------------------------------------------------------------
const SEPTEMBER: LedgerFill[] = [
  {
    marketId: 10,
    direction: 1,
    sizeUnits: 214,
    priceUsd: 0.023308,
    feeUsd: 0.00444,
    timestampMs: Date.parse("2026-09-14T22:34:22.662Z"),
    orderId: 0,
  },
  {
    marketId: 10,
    direction: 1,
    sizeUnits: 131,
    priceUsd: 0.022913,
    feeUsd: 0.002673,
    timestampMs: Date.parse("2026-09-15T05:32:27.617Z"),
    orderId: 0,
  },
  {
    marketId: 10,
    direction: 1,
    sizeUnits: 231,
    priceUsd: 0.02159454978354979,
    feeUsd: 0.00444,
    timestampMs: Date.parse("2026-09-15T20:56:56.210Z"),
    orderId: 0,
  },
  {
    marketId: 10,
    direction: -1,
    sizeUnits: 576,
    priceUsd: 0.02316627951388889,
    feeUsd: 0,
    timestampMs: Date.parse("2026-09-18T06:17:01.436Z"),
    orderId: 0,
  },
];

describe("the September round trip", () => {
  const led = tripsFromFills(SEPTEMBER);

  it("is one closed long of 576 units", () => {
    expect(led.trips).toHaveLength(1);
    expect(led.closed).toBe(1);
    expect(led.open).toBe(0);
    const t = led.trips[0]!;
    expect(t.side).toBe("long");
    expect(t.open).toBe(false);
    expect(t.units).toBe(576);
    expect(t.fills).toBe(4);
  });

  it("made $0.354368 after fees, not $0.365921 before them", () => {
    const t = led.trips[0]!;
    // Bought 576 units for $12.9779, sold them for $13.3423.
    expect(t.entryUsd).toBeCloseTo(0.022531, 8);
    expect(t.exitUsd).toBeCloseTo(0.02316627951388889, 12);
    expect(t.feesUsd).toBeCloseTo(0.011553, 9);
    expect(t.netUsd).toBeCloseTo(0.354368, 8);
    expect(led.realisedUsd).toBeCloseTo(0.354368, 8);
  });

  it("agrees with the fold the loss ceiling enforces against", () => {
    // The whole design rests on this: the screen's number IS foldFills'
    // number. If these ever diverge, the hunter is shown one result and the
    // leash counts another.
    const total = foldFills(SEPTEMBER).realized.reduce(
      (s, r) => s + r.realizedUsd,
      0,
    );
    expect(led.realisedUsd).toBeCloseTo(total, 12);
  });
});

describe("an open position", () => {
  const led = tripsFromFills([
    fill({
      direction: 1,
      sizeUnits: 100,
      priceUsd: 0.02,
      feeUsd: 0.01,
      timestampMs: 1,
    }),
    fill({
      direction: 1,
      sizeUnits: 100,
      priceUsd: 0.03,
      feeUsd: 0.01,
      timestampMs: 2,
    }),
  ]);

  it("is reported open, and its net is only the fees paid so far", () => {
    const t = led.trips[0]!;
    expect(t.open).toBe(true);
    expect(t.closedAtMs).toBeNull();
    expect(t.exitUsd).toBeNull();
    expect(t.units).toBe(200);
    expect(t.entryUsd).toBeCloseTo(0.025, 9);
    expect(t.netUsd).toBeCloseTo(-0.02, 9);
  });

  it("is excluded from realised — nothing has been realised", () => {
    expect(led.realisedUsd).toBe(0);
    expect(led.closed).toBe(0);
    expect(led.open).toBe(1);
    // Fees are counted regardless: they left the account whether or not the
    // trade ever closes.
    expect(led.feesUsd).toBeCloseTo(0.02, 9);
  });
});

describe("a losing trip", () => {
  it("reports a loss rather than an absolute value", () => {
    const led = tripsFromFills([
      fill({ direction: 1, priceUsd: 0.03, timestampMs: 1 }),
      fill({ direction: -1, priceUsd: 0.02, timestampMs: 2 }),
    ]);
    expect(led.trips[0]!.netUsd).toBeCloseTo(-1, 9);
    expect(led.realisedUsd).toBeCloseTo(-1, 9);
  });
});

describe("a short", () => {
  it("makes money when the price falls", () => {
    const led = tripsFromFills([
      fill({ direction: -1, priceUsd: 0.03, timestampMs: 1 }),
      fill({ direction: 1, priceUsd: 0.02, timestampMs: 2 }),
    ]);
    const t = led.trips[0]!;
    expect(t.side).toBe("short");
    expect(t.entryUsd).toBeCloseTo(0.03, 9);
    expect(t.exitUsd).toBeCloseTo(0.02, 9);
    expect(t.netUsd).toBeCloseTo(1, 9);
  });
});

describe("flipping through zero", () => {
  const led = tripsFromFills([
    fill({ direction: 1, sizeUnits: 100, priceUsd: 0.02, timestampMs: 1 }),
    fill({ direction: -1, sizeUnits: 150, priceUsd: 0.03, timestampMs: 2 }),
    fill({ direction: 1, sizeUnits: 50, priceUsd: 0.025, timestampMs: 3 }),
  ]);

  it("is two trips, not one confusing one", () => {
    expect(led.trips).toHaveLength(2);
    expect(led.closed).toBe(2);
  });

  it("closes the long at a profit and the short at one too", () => {
    const [second, first] = led.trips; // newest first
    expect(first!.side).toBe("long");
    expect(first!.netUsd).toBeCloseTo(1, 9); // 100 * (0.03 - 0.02)
    expect(second!.side).toBe("short");
    // Sold 50 at 0.03, bought them back at 0.025.
    expect(second!.netUsd).toBeCloseTo(0.25, 9);
  });

  it("still sums to the fold's total", () => {
    const total = foldFills([
      fill({ direction: 1, sizeUnits: 100, priceUsd: 0.02, timestampMs: 1 }),
      fill({ direction: -1, sizeUnits: 150, priceUsd: 0.03, timestampMs: 2 }),
      fill({ direction: 1, sizeUnits: 50, priceUsd: 0.025, timestampMs: 3 }),
    ]).realized.reduce((s, r) => s + r.realizedUsd, 0);
    expect(led.realisedUsd).toBeCloseTo(total, 12);
  });
});

describe("two markets at once", () => {
  it("keeps them apart", () => {
    const led = tripsFromFills([
      fill({ marketId: 1, direction: 1, priceUsd: 0.02, timestampMs: 1 }),
      fill({ marketId: 2, direction: 1, priceUsd: 5, timestampMs: 2 }),
      fill({ marketId: 1, direction: -1, priceUsd: 0.03, timestampMs: 3 }),
    ]);
    expect(led.closed).toBe(1);
    expect(led.open).toBe(1);
    expect(led.trips.find((t) => t.marketId === 2)!.open).toBe(true);
  });
});

describe("an empty ledger", () => {
  it("is zero, not a crash and not a fabricated row", () => {
    const led = tripsFromFills([]);
    expect(led.trips).toEqual([]);
    expect(led.realisedUsd).toBe(0);
    expect(led.feesUsd).toBe(0);
  });
});

describe("fills arriving out of order", () => {
  it("is sorted before folding, so the sell cannot precede its buy", () => {
    const led = tripsFromFills([
      fill({ direction: -1, priceUsd: 0.03, timestampMs: 2 }),
      fill({ direction: 1, priceUsd: 0.02, timestampMs: 1 }),
    ]);
    expect(led.trips[0]!.side).toBe("long");
    expect(led.realisedUsd).toBeCloseTo(1, 9);
  });
});
