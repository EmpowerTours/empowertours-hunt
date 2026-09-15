import { describe, expect, it } from "vitest";
import { mayReduce } from "./enforce";
import { planClose, T_CLOSE_LONG, T_CLOSE_SHORT } from "./order";
import { MON_MARKET } from "./order";

// A market with a finer size grid, to exercise flooring.
const FINE = { id: 20, symbol: "K", priceDecimals: 6, sizeDecimals: 2 };

describe("mayReduce — the gate that must not be a trap", () => {
  it("permits a full close", () => {
    expect(mayReduce({ market: "MON", signedSize: 576 }, 576)).toEqual({
      ok: true,
    });
  });

  it("permits a partial reduce", () => {
    expect(mayReduce({ market: "MON", signedSize: 576 }, 100).ok).toBe(true);
  });

  it("permits closing a SHORT, where held size is negative", () => {
    expect(mayReduce({ market: "MON", signedSize: -576 }, 576).ok).toBe(true);
  });

  it("refuses when nothing is open", () => {
    expect(mayReduce({ market: "MON", signedSize: 0 }, 10)).toEqual({
      ok: false,
      reason: "nothing_to_reduce",
    });
  });

  it("refuses a zero or negative request", () => {
    expect(mayReduce({ market: "MON", signedSize: 576 }, 0).ok).toBe(false);
    expect(mayReduce({ market: "MON", signedSize: 576 }, -5).ok).toBe(false);
  });

  it("refuses more than is held — that is a flip, not a reduce", () => {
    // Closing past flat opens exposure the other way, which is new risk and
    // belongs under mayOpen with the ceilings.
    expect(mayReduce({ market: "MON", signedSize: 576 }, 577)).toEqual({
      ok: false,
      reason: "reduce_exceeds_position",
    });
  });
});

describe("mayReduce is NOT gated on the leash", () => {
  // The property that matters, stated as a test so it cannot be quietly
  // "tightened" later by someone adding a ceiling here. A hunter who has hit
  // every limit is precisely the hunter who needs to cut risk.
  it("takes no bound and no day-state at all", () => {
    // Signature check: two arguments, position and size. If a future change
    // adds a bound it will fail here first.
    expect(mayReduce.length).toBe(2);
  });

  it("permits a reduce regardless of how much is held or how large", () => {
    for (const held of [0.0001, 1, 1e9]) {
      expect(mayReduce({ market: "MON", signedSize: held }, held).ok).toBe(
        true,
      );
    }
  });
});

describe("planClose — the side comes from the position, never the caller", () => {
  it("closes a long with a SELL (T_CLOSE_LONG)", () => {
    const p = planClose({
      market: MON_MARKET,
      openSignedSize: 576,
      markPriceUsd: 0.02148,
    });
    expect(p.orderType).toBe(T_CLOSE_LONG);
    expect(p.sizeUnits).toBe(576);
    expect(p.full).toBe(true);
    expect(p.decision.ok).toBe(true);
    expect(p.notionalUsd).toBeCloseTo(576 * 0.02148, 9);
  });

  it("closes a short with a BUY (T_CLOSE_SHORT)", () => {
    const p = planClose({
      market: MON_MARKET,
      openSignedSize: -576,
      markPriceUsd: 0.02148,
    });
    expect(p.orderType).toBe(T_CLOSE_SHORT);
    expect(p.sizeUnits).toBe(576);
  });

  it("omitting the size closes the whole position", () => {
    expect(
      planClose({
        market: MON_MARKET,
        openSignedSize: 576,
        markPriceUsd: 0.02148,
      }).sizeUnits,
    ).toBe(576);
  });

  it("a partial reduce is not marked full", () => {
    const p = planClose({
      market: MON_MARKET,
      openSignedSize: 576,
      requestedUnits: 100,
      markPriceUsd: 0.02148,
    });
    expect(p.sizeUnits).toBe(100);
    expect(p.full).toBe(false);
    expect(p.decision.ok).toBe(true);
  });

  it("clamps a request larger than the position instead of refusing it", () => {
    // Asking to close 1000 of 576 is a full close, not an error: the intent is
    // unambiguous and refusing would be pedantry at the hunter's expense.
    const p = planClose({
      market: MON_MARKET,
      openSignedSize: 576,
      requestedUnits: 1000,
      markPriceUsd: 0.02148,
    });
    expect(p.sizeUnits).toBe(576);
    expect(p.full).toBe(true);
    expect(p.decision.ok).toBe(true);
  });

  it("never leaves dust when closing everything on a fractional grid", () => {
    // 12.345 floors to 12.34 on a 2dp grid. A hunter who asked for all of it
    // would be left holding 0.005 and would find out from a funding charge.
    const p = planClose({
      market: FINE,
      openSignedSize: 12.345,
      requestedUnits: 12.345,
      markPriceUsd: 2,
    });
    expect(p.sizeUnits).toBe(12.345);
    expect(p.full).toBe(true);
  });

  it("still floors a genuine partial to the grid", () => {
    const p = planClose({
      market: FINE,
      openSignedSize: 12.345,
      requestedUnits: 5.678,
      markPriceUsd: 2,
    });
    expect(p.sizeUnits).toBeCloseTo(5.67, 9);
    expect(p.full).toBe(false);
  });

  it("refuses when there is nothing open", () => {
    const p = planClose({
      market: MON_MARKET,
      openSignedSize: 0,
      markPriceUsd: 0.02148,
    });
    expect(p.decision).toEqual({ ok: false, reason: "nothing_to_reduce" });
  });
});
