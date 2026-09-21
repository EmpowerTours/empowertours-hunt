import { describe, expect, it } from "vitest";
import { turboProgressPercent } from "./format";

const MON = 10n ** 18n;

/* ---------------------------------------------------------------------------
   turboProgressPercent used to divide by a hardcoded 139 WMON while the
   deployed cohort price was settable and different. The denominator is now a
   parameter, and these lock in what happens when it cannot be read.
--------------------------------------------------------------------------- */

describe("turboProgressPercent", () => {
  it("is 0 when the month price could not be read", () => {
    // Null prices reach here as 0n via weiOrZero. Any non-zero answer would be
    // invented from a denominator nobody supplied.
    expect(turboProgressPercent(50n * MON, 0n)).toBe(0);
    expect(turboProgressPercent(50n * MON, -1n)).toBe(0);
  });

  it("is 0 with no credit, whatever the price", () => {
    expect(turboProgressPercent(0n, 139n * MON)).toBe(0);
    expect(turboProgressPercent(-5n, 139n * MON)).toBe(0);
  });

  it("caps at 100 once credit covers a month", () => {
    expect(turboProgressPercent(139n * MON, 139n * MON)).toBe(100);
    expect(turboProgressPercent(500n * MON, 139n * MON)).toBe(100);
  });

  it("tracks the price it is given, not a constant", () => {
    const credit = 1n * MON;
    // The same credit against two different live prices must differ. Against
    // the old hardcoded 139 this test's second case read 0.7%, not 100%.
    expect(turboProgressPercent(credit, 4n * MON)).toBe(25);
    expect(turboProgressPercent(credit, 1n * MON)).toBe(100);
  });

  it("keeps one decimal place and never overflows the bigint", () => {
    expect(turboProgressPercent(1n * MON, 3n * MON)).toBe(33.3);
    // A cheap-price window: 0.001 WMON months are real, and the ratio still
    // has to survive the integer scaling.
    expect(turboProgressPercent(10n ** 15n / 2n, 10n ** 15n)).toBe(50);
  });
});
