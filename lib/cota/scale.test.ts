import { describe, expect, it } from "vitest";
import {
  LossyScaleError,
  fromLeverageX100,
  fromUsdE6,
  leverageX100,
  usdE6,
} from "./scale";

describe("values that land exactly on the grid", () => {
  it("scales dollars to 1e6", () => {
    expect(usdE6(200)).toBe(200_000_000n);
    expect(usdE6(12.34)).toBe(12_340_000n);
    expect(usdE6(0.000001)).toBe(1n);
    expect(usdE6(0)).toBe(0n);
  });

  it("scales leverage to hundredths", () => {
    expect(leverageX100(3)).toBe(300n);
    expect(leverageX100(3.25)).toBe(325n);
    expect(leverageX100(1)).toBe(100n);
  });

  it("accepts values whose float representation is not exact", () => {
    // 12.34 * 1e6 is 12339999.999999998 in IEEE-754. If the tolerance were
    // zero this would throw, and every ordinary dollar amount with cents
    // would be unsignable.
    expect(() => usdE6(12.34)).not.toThrow();
    expect(() => usdE6(0.07)).not.toThrow();
    expect(() => leverageX100(1.1)).not.toThrow();
  });
});

describe("values between grid points are refused, never rounded", () => {
  it("refuses leverage finer than a hundredth", () => {
    expect(() => leverageX100(3.005)).toThrow(LossyScaleError);
    expect(() => leverageX100(2.001)).toThrow(LossyScaleError);
  });

  it("refuses USD finer than a millionth", () => {
    expect(() => usdE6(0.0000005)).toThrow(LossyScaleError);
  });

  it("names the field and the grid in the message", () => {
    // A ceiling that fails to scale is something the player must fix in the
    // form, so the error has to say which field and what is allowed.
    expect(() => leverageX100(3.005, "maxLeverage")).toThrow(/maxLeverage/);
    expect(() => leverageX100(3.005, "maxLeverage")).toThrow(/0\.01 grid/);
  });

  it("refuses negatives and non-finite values", () => {
    expect(() => usdE6(-1)).toThrow(LossyScaleError);
    expect(() => usdE6(Number.NaN)).toThrow(LossyScaleError);
    expect(() => usdE6(Number.POSITIVE_INFINITY)).toThrow(LossyScaleError);
  });

  it("is a RangeError, so numeric-domain catches work", () => {
    expect(() => usdE6(-1)).toThrow(RangeError);
  });
});

describe("rounding would silently move a ceiling", () => {
  it("does not round 3.005 to either neighbour", () => {
    // The whole point: 3.005 must not become 3.00 (a limit tighter than the
    // player read) or 3.01 (looser). Both are ceilings nobody agreed to.
    expect(() => leverageX100(3.005)).toThrow();
    expect(leverageX100(3.0)).toBe(300n);
    expect(leverageX100(3.01)).toBe(301n);
  });
});

describe("rendering back what was signed", () => {
  it("round-trips USD", () => {
    expect(fromUsdE6(usdE6(200))).toBe("200");
    expect(fromUsdE6(usdE6(12.34))).toBe("12.34");
    expect(fromUsdE6(usdE6(0.000001))).toBe("0.000001");
    expect(fromUsdE6(0n)).toBe("0");
  });

  it("round-trips leverage", () => {
    expect(fromLeverageX100(leverageX100(3))).toBe("3");
    expect(fromLeverageX100(leverageX100(3.25))).toBe("3.25");
    expect(fromLeverageX100(leverageX100(1.5))).toBe("1.5");
  });
});
