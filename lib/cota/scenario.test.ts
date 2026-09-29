import { describe, expect, it } from "vitest";
import { DEFAULT_MOVES_PCT, scenario, type Quote } from "./scenario";
import { PER_SIDE_FEE_BPS } from "./exit";

// The live MON book, read from Perpl's public context endpoint on 2026-09-29:
// mrk 27131, bid 27189, ask 27260, price_decimals 6. Note the mark sits OUTSIDE
// the book — below the bid — which is why nothing here prices against it.
const MON: Quote = { markUsd: 0.027131, bidUsd: 0.027189, askUsd: 0.02726 };

describe("a flat market is already a loss", () => {
  const s = scenario({ side: "long", notionalUsd: 3, leverageX: 1 }, MON)!;

  it("enters at the ask, not the mid and not the mark", () => {
    expect(s.entryPriceUsd).toBe(MON.askUsd);
    expect(s.units).toBeCloseTo(3 / 0.02726, 6);
  });

  it("is down the spread plus both fees at a zero move", () => {
    const flat = s.rows.find((r) => r.movePct === 0)!;
    expect(flat.netUsd).toBeLessThan(0);
    // Spread (26.1 bps) + 17.8 bps of fees on $3 ≈ 1.3 cents.
    expect(s.roundTripCostUsd).toBeCloseTo(-flat.netUsd, 12);
    expect(s.roundTripCostUsd).toBeCloseTo(0.0132, 3);
  });

  it("reports the spread the book actually shows", () => {
    expect(s.spreadBps).toBeCloseTo(26.08, 1);
  });
});

describe("breakeven", () => {
  it("is a rise for a long and a fall for a short", () => {
    const l = scenario({ side: "long", notionalUsd: 3, leverageX: 1 }, MON)!;
    const sh = scenario({ side: "short", notionalUsd: 3, leverageX: 1 }, MON)!;
    expect(l.breakevenMovePct).toBeGreaterThan(0);
    expect(sh.breakevenMovePct).toBeLessThan(0);
  });

  it("round-trips: the move it names really does net zero", () => {
    // This is the test that keeps the closed form honest. If the algebra ever
    // drifts from netAtExit, the number on screen becomes a confident lie.
    for (const side of ["long", "short"] as const) {
      for (const lev of [1, 2, 5]) {
        const s = scenario({ side, notionalUsd: 7.5, leverageX: lev }, MON)!;
        const at = scenario({ side, notionalUsd: 7.5, leverageX: lev }, MON, {
          movesPct: [s.breakevenMovePct],
        })!;
        expect(at.rows[0]!.netUsd).toBeCloseTo(0, 12);
      }
    }
  });

  it("is wider than the fees alone, because the spread is crossed twice", () => {
    const s = scenario({ side: "long", notionalUsd: 3, leverageX: 1 }, MON)!;
    expect(s.breakevenMovePct).toBeGreaterThan((2 * PER_SIDE_FEE_BPS) / 100);
  });
});

describe("leverage", () => {
  const base = { side: "long", notionalUsd: 10 } as const;

  it("leaves the money untouched and only divides the margin", () => {
    const one = scenario({ ...base, leverageX: 1 }, MON)!;
    const five = scenario({ ...base, leverageX: 5 }, MON)!;
    const a = one.rows.find((r) => r.movePct === 5)!;
    const b = five.rows.find((r) => r.movePct === 5)!;
    expect(b.netUsd).toBeCloseTo(a.netUsd, 12);
    expect(five.marginUsd).toBeCloseTo(2, 12);
    expect(b.netPctOfMargin).toBeCloseTo(a.netPctOfMargin * 5, 9);
  });

  it("turns a 5% move into ~25% of your money at 5x", () => {
    const five = scenario({ ...base, leverageX: 5 }, MON)!;
    const up = five.rows.find((r) => r.movePct === 5)!;
    // Under 25 because the round trip is paid out of it.
    expect(up.netPctOfMargin).toBeGreaterThan(20);
    expect(up.netPctOfMargin).toBeLessThan(25);
  });
});

describe("the leash stop, which replaces a liquidation price", () => {
  it("names the move that realises exactly the signed ceiling", () => {
    const s = scenario({ side: "long", notionalUsd: 10, leverageX: 2 }, MON, {
      maxDailyLossUsd: 1,
    })!;
    expect(s.leashStopMovePct).toBeLessThan(0);
    const at = scenario({ side: "long", notionalUsd: 10, leverageX: 2 }, MON, {
      movesPct: [s.leashStopMovePct!],
    })!;
    expect(at.rows[0]!.netUsd).toBeCloseTo(-1, 12);
  });

  it("works upward for a short", () => {
    const s = scenario({ side: "short", notionalUsd: 10, leverageX: 2 }, MON, {
      maxDailyLossUsd: 1,
    })!;
    expect(s.leashStopMovePct).toBeGreaterThan(0);
    const at = scenario({ side: "short", notionalUsd: 10, leverageX: 2 }, MON, {
      movesPct: [s.leashStopMovePct!],
    })!;
    expect(at.rows[0]!.netUsd).toBeCloseTo(-1, 12);
  });

  it("is null when no ceiling was given, never zero", () => {
    const s = scenario({ side: "long", notionalUsd: 10, leverageX: 2 }, MON)!;
    expect(s.leashStopMovePct).toBeNull();
    expect(s.leashStopPriceUsd).toBeNull();
  });
});

describe("direction", () => {
  it("pays a long when the price rises and a short when it falls", () => {
    const l = scenario({ side: "long", notionalUsd: 10, leverageX: 1 }, MON)!;
    const s = scenario({ side: "short", notionalUsd: 10, leverageX: 1 }, MON)!;
    expect(l.rows.find((r) => r.movePct === 10)!.netUsd).toBeGreaterThan(0);
    expect(l.rows.find((r) => r.movePct === -10)!.netUsd).toBeLessThan(0);
    expect(s.rows.find((r) => r.movePct === -10)!.netUsd).toBeGreaterThan(0);
    expect(s.rows.find((r) => r.movePct === 10)!.netUsd).toBeLessThan(0);
  });

  it("shows both directions, so neither is buried", () => {
    expect(DEFAULT_MOVES_PCT).toContain(-10);
    expect(DEFAULT_MOVES_PCT).toContain(10);
    expect(DEFAULT_MOVES_PCT.filter((m) => m < 0)).toHaveLength(3);
    expect(DEFAULT_MOVES_PCT.filter((m) => m > 0)).toHaveLength(3);
  });
});

describe("refusing rather than flattering", () => {
  it("returns null on an unusable book, not a table of zeroes", () => {
    const plan = { side: "long", notionalUsd: 3, leverageX: 1 } as const;
    expect(scenario(plan, { ...MON, bidUsd: 0 })).toBeNull();
    expect(scenario(plan, { ...MON, askUsd: 0 })).toBeNull();
    // Crossed book — the venue is not giving a coherent price.
    expect(scenario(plan, { markUsd: 1, bidUsd: 2, askUsd: 1 })).toBeNull();
  });

  it("returns null on a size or leverage that cannot be traded", () => {
    expect(
      scenario({ side: "long", notionalUsd: 0, leverageX: 1 }, MON),
    ).toBeNull();
    expect(
      scenario({ side: "long", notionalUsd: 3, leverageX: 0 }, MON),
    ).toBeNull();
  });
});

describe("a ceiling the trade cannot reach", () => {
  const MON2: Quote = { markUsd: 0.027131, bidUsd: 0.027189, askUsd: 0.02726 };

  it("says so instead of printing a move past −100%", () => {
    // A $5 daily cap on a $3 long: the price would have to go below zero.
    const s = scenario({ side: "long", notionalUsd: 3, leverageX: 1 }, MON2, {
      maxDailyLossUsd: 5,
    })!;
    expect(s.leashStopUnreachable).toBe(true);
    expect(s.leashStopMovePct).toBeNull();
    expect(s.leashStopPriceUsd).toBeNull();
  });

  it("still binds when the cap is inside the worst case", () => {
    const s = scenario({ side: "long", notionalUsd: 3, leverageX: 1 }, MON2, {
      maxDailyLossUsd: 2,
    })!;
    expect(s.leashStopUnreachable).toBe(false);
    expect(s.leashStopMovePct).toBeLessThan(0);
    expect(s.leashStopMovePct).toBeGreaterThan(-100);
  });

  it("never reports a short's cap as unreachable — the price has no ceiling", () => {
    const s = scenario({ side: "short", notionalUsd: 3, leverageX: 1 }, MON2, {
      maxDailyLossUsd: 500,
    })!;
    expect(s.leashStopUnreachable).toBe(false);
    expect(s.leashStopMovePct).toBeGreaterThan(0);
  });
});

describe("the worst case", () => {
  const MON3: Quote = { markUsd: 0.027131, bidUsd: 0.027189, askUsd: 0.02726 };

  it("for a long is the notional plus the entry fee", () => {
    const s = scenario({ side: "long", notionalUsd: 10, leverageX: 3 }, MON3)!;
    expect(s.worstCaseUsd).toBeCloseTo(
      -10 * (1 + PER_SIDE_FEE_BPS / 10_000),
      9,
    );
  });

  it("for a short is null, because it is unbounded", () => {
    const s = scenario({ side: "short", notionalUsd: 10, leverageX: 3 }, MON3)!;
    // Null means unbounded. Rendering it as a number would be a lie about the
    // one direction that can take more than was put in.
    expect(s.worstCaseUsd).toBeNull();
  });
});
