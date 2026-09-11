import { describe, expect, it } from "vitest";
import { directionOfOrderType, fillToLedgerFill } from "./normalize";
import { MON_MARKET } from "../order";
import type { Fill } from "./frames";

describe("directionOfOrderType", () => {
  it("open long / close short are buys (+1)", () => {
    expect(directionOfOrderType(1)).toBe(1); // T_OPEN_LONG
    expect(directionOfOrderType(4)).toBe(1); // T_CLOSE_SHORT
  });
  it("open short / close long are sells (-1)", () => {
    expect(directionOfOrderType(2)).toBe(-1); // T_OPEN_SHORT
    expect(directionOfOrderType(3)).toBe(-1); // T_CLOSE_LONG
  });
  it("throws on an unknown type", () => {
    expect(() => directionOfOrderType(9)).toThrow(/unknown order type 9/);
  });
});

describe("fillToLedgerFill — descale off the wire", () => {
  const fill: Fill = {
    orderRq: 42,
    sizeScaled: 116, // MON size_decimals 0 → 116 units
    priceScaled: 25_000, // price_decimals 6 → $0.025
    feeBaseUnits: "1000", // AUSD 6dp → $0.001
    builderFeeBaseUnits: "0",
  };

  it("descales size, price and fee and carries direction + order id", () => {
    const lf = fillToLedgerFill(fill, MON_MARKET, 1 /* open long */, 1_700_000);
    expect(lf).toEqual({
      marketId: 10,
      direction: 1,
      sizeUnits: 116,
      priceUsd: 0.025,
      feeUsd: 0.001,
      timestampMs: 1_700_000,
      orderId: 42,
    });
  });

  it("a close-long fill is a sell", () => {
    expect(fillToLedgerFill(fill, MON_MARKET, 3, 1).direction).toBe(-1);
  });
});
