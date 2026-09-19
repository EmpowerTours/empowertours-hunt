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
    const lf = fillToLedgerFill(
      fill,
      MON_MARKET,
      1 /* open long */,
      1_700_000,
      4242,
    );
    expect(lf).toEqual({
      marketId: 10,
      direction: 1,
      sizeUnits: 116,
      priceUsd: 0.025,
      feeUsd: 0.001,
      timestampMs: 1_700_000,
      // The CALLER's id, not the fill's rq (42 above) — the wire rq is 1 on
      // every order this agent sends, so counting distinct orders by it always
      // answered 1 and the trades-per-day ceiling never bound.
      orderId: 4242,
      // Reachable only with a real mt 25 frame in hand, so it is observed by
      // construction.
      source: "observed",
      // No mark passed: null, not absent and not a guess.
      venueMarkUsd: null,
    });
  });

  it("a close-long fill is a sell", () => {
    expect(fillToLedgerFill(fill, MON_MARKET, 3, 1, 1).direction).toBe(-1);
  });

  it("records the venue mark when the caller has one", () => {
    const lf = fillToLedgerFill(fill, MON_MARKET, 1, 1_700_000, 4242, 0.0251);
    expect(lf.venueMarkUsd).toBe(0.0251);
    expect(lf.source).toBe("observed");
  });

  it("a mark of 0 is recorded, not swallowed as absent", () => {
    // `?? null` and not `|| null`: a legitimately zero mark must survive. With
    // `||` this row would claim no mark was known, which is a different and
    // wrong statement.
    expect(fillToLedgerFill(fill, MON_MARKET, 1, 1, 1, 0).venueMarkUsd).toBe(0);
  });

  it("never stamps a fill it built as adopted", () => {
    // The whole point of the column: if this function could ever produce
    // `adopted`, the two kinds would be back to indistinguishable.
    for (const ot of [1, 2, 3, 4]) {
      expect(fillToLedgerFill(fill, MON_MARKET, ot, 1, 1).source).toBe(
        "observed",
      );
    }
  });
});
