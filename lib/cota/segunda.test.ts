import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEGUNDA_POLICY,
  adverseBps,
  divergenceBps,
  segundaVerdict,
  spotIsCheaperBps,
} from "./segunda";

// ---------------------------------------------------------------------------
// The measurements these tests are built from are real, taken 2026-09-20 two
// minutes apart on mainnet:
//
//   perp premium: +15.1 +15.5 +5.1 +21.8 +10.0 +26.1 bps   (never negative)
//   perpl spread:  19.6  20.8 15.1  13.0  18.7  15.9 bps
//   kuru spread:    3.3   6.1  6.5   4.5   5.3   3.7 bps
//
// Two properties matter more than any single number.
//
// DIRECTIONALITY. A rich perp hurts a buyer and helps a seller. A check on
// |divergence| would refuse the trades the dislocation favours, which is
// exactly backwards, and no absolute-value test would catch that.
//
// FAILING CLOSED. When Kuru cannot be read the verdict must refuse, because a
// safety check that disables itself when its data is missing is not one.
// ---------------------------------------------------------------------------

const book = (bid: number, ask: number) => ({ bidUsd: bid, askUsd: ask });

/** Perpl and Kuru as measured in sample 6 — the widest premium seen. */
const PERP_RICH = book(0.0245345, 0.0245735); // mid 0.024554, ~15.9 bps wide
const SPOT = book(0.0244855, 0.0244945); // mid 0.024490, ~3.7 bps wide

describe("divergenceBps", () => {
  it("is positive when the perp trades above spot", () => {
    const d = divergenceBps(PERP_RICH, SPOT);
    expect(d).not.toBeNull();
    // Sample 6 measured +26.1 bps.
    expect(d as number).toBeCloseTo(26.1, 0);
  });

  it("is negative when the perp trades below spot", () => {
    expect(divergenceBps(SPOT, PERP_RICH) as number).toBeLessThan(0);
  });

  it("returns null rather than a number it cannot stand behind", () => {
    // A divergence computed from a zero or a NaN reads as agreement, which is
    // the most dangerous possible wrong answer here.
    expect(divergenceBps(book(0, 0), SPOT)).toBeNull();
    expect(divergenceBps(PERP_RICH, book(0, 0))).toBeNull();
    expect(divergenceBps(book(Number.NaN, 1), SPOT)).toBeNull();
    expect(divergenceBps(PERP_RICH, book(1, Number.NaN))).toBeNull();
  });
});

describe("adverseBps — the directional half", () => {
  it("a rich perp is adverse to a long and favourable to a short", () => {
    expect(adverseBps("long", 26.1)).toBeCloseTo(26.1);
    expect(adverseBps("short", 26.1)).toBeCloseTo(-26.1);
  });

  it("a cheap perp is favourable to a long and adverse to a short", () => {
    expect(adverseBps("long", -26.1)).toBeCloseTo(-26.1);
    expect(adverseBps("short", -26.1)).toBeCloseTo(26.1);
  });
});

describe("segundaVerdict", () => {
  it("allows the ordinary measured basis — otherwise the agent never trades", () => {
    // Every one of the six real samples must pass, or the gate is useless.
    for (const premium of [15.1, 15.5, 5.1, 21.8, 10.0, 26.1]) {
      const perp = book(
        SPOT.bidUsd * (1 + premium / 10_000),
        SPOT.askUsd * (1 + premium / 10_000),
      );
      const v = segundaVerdict({ direction: "long", perp, spot: SPOT });
      expect(v.ok, `premium ${premium} bps should be allowed`).toBe(true);
    }
  });

  it("refuses a long when the perp is dislocated past the limit", () => {
    const perp = book(SPOT.bidUsd * 1.06, SPOT.askUsd * 1.06); // 600 bps rich
    const v = segundaVerdict({ direction: "long", perp, spot: SPOT });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/against this long/);
  });

  it("ALLOWS a short into that same dislocation — it is favourable there", () => {
    // The test that would fail an |divergence| implementation.
    const perp = book(SPOT.bidUsd * 1.06, SPOT.askUsd * 1.06);
    expect(segundaVerdict({ direction: "short", perp, spot: SPOT }).ok).toBe(
      true,
    );
  });

  it("refuses when Kuru cannot be read, and says which failure it was", () => {
    const v = segundaVerdict({
      direction: "long",
      perp: PERP_RICH,
      spot: null,
    });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toMatch(/second price source/);
      // Distinguishable in a decision log from "the price was bad".
      expect(v.divergenceBps).toBeNull();
    }
  });

  it("can be told to proceed without a second source, but never by default", () => {
    expect(DEFAULT_SEGUNDA_POLICY.requireSecondSource).toBe(true);
    const v = segundaVerdict({
      direction: "long",
      perp: PERP_RICH,
      spot: null,
      policy: { ...DEFAULT_SEGUNDA_POLICY, requireSecondSource: false },
    });
    expect(v.ok).toBe(true);
  });

  it("straddles the limit — allows just under, refuses just over", () => {
    // Deliberately NOT built as `spot * 1.01`. That scales to
    // 99.99999999999973 bps, which is genuinely below 100, so a test written
    // that way asserts a property of floating point rather than of this
    // module — and it fails for a reason that has nothing to do with the gate.
    const at = (bps: number) =>
      book(
        SPOT.bidUsd * (1 + bps / 10_000),
        SPOT.askUsd * (1 + bps / 10_000),
      );
    expect(
      segundaVerdict({ direction: "long", perp: at(99), spot: SPOT }).ok,
    ).toBe(true);
    expect(
      segundaVerdict({ direction: "long", perp: at(101), spot: SPOT }).ok,
    ).toBe(false);
  });
});

describe("spotIsCheaperBps", () => {
  it("finds spot cheaper when the perp carries a premium", () => {
    // Perp: ~8 bps half-spread + 8.9 fee + 26.1 premium. Kuru: ~1.9 bps.
    const c = spotIsCheaperBps({
      direction: "long",
      perp: PERP_RICH,
      spot: SPOT,
    });
    expect(c).not.toBeNull();
    expect(c as number).toBeGreaterThan(30);
  });

  it("does not claim spot is cheaper for a short into a rich perp", () => {
    // Selling a rich perp is the good side of the dislocation; the premium
    // counts in the short's favour and should pull this number down.
    const long = spotIsCheaperBps({
      direction: "long",
      perp: PERP_RICH,
      spot: SPOT,
    }) as number;
    const short = spotIsCheaperBps({
      direction: "short",
      perp: PERP_RICH,
      spot: SPOT,
    }) as number;
    expect(short).toBeLessThan(long);
  });

  it("returns null when a book is unusable", () => {
    expect(
      spotIsCheaperBps({ direction: "long", perp: book(0, 0), spot: SPOT }),
    ).toBeNull();
  });
});
