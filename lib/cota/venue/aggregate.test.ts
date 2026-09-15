import { describe, expect, it } from "vitest";
import {
  buildAggregateState,
  entryUsdFromFrame,
  positionsReconcile,
  signedSizeFromFrame,
  unrealisedFromVenueUsd,
} from "./aggregate";
import { toDayState, USD_SCALE, type MarkedMarket } from "./account-state";
import type { LedgerFill } from "./pnl";
import type { OpenPositionFrame } from "./frames";
import { MON_MARKET } from "../order";

const T0 = Date.UTC(2026, 8, 10, 20, 0, 0);
const marks = new Map<number, MarkedMarket>([
  [10, { market: MON_MARKET, markUsd: 0.02 }],
]);
const marksAt = (markUsd: number) =>
  new Map<number, MarkedMarket>([[10, { market: MON_MARKET, markUsd }]]);

/**
 * The first position this executor ever opened, verbatim off account 5273's
 * mt 26 frame on 2026-09-14. `ep` is the field the fills-VWAP ledger was built
 * on the premise of not existing.
 */
const POS_5273: OpenPositionFrame = {
  pid: 6870209921025,
  marketId: 10,
  side: 1,
  sizeScaled: 214,
  leverageX100: 200,
  entryPriceScaled: 23308,
  feeScaled: 4440,
};

function vpos(p: Partial<OpenPositionFrame>): OpenPositionFrame {
  return {
    pid: 1,
    marketId: 10,
    side: 1,
    sizeScaled: 100,
    leverageX100: 100,
    entryPriceScaled: null,
    feeScaled: null,
    ...p,
  };
}
function ledgerFill(p: Partial<LedgerFill>): LedgerFill {
  return {
    marketId: 10,
    direction: 1,
    sizeUnits: 100,
    priceUsd: 0.05,
    feeUsd: 0,
    timestampMs: T0,
    orderId: 1,
    ...p,
  };
}

describe("signedSizeFromFrame", () => {
  it("long is positive, short is negative, descaled by size_decimals", () => {
    expect(signedSizeFromFrame(vpos({ side: 1, sizeScaled: 100 }), marks)).toBe(
      100,
    );
    expect(signedSizeFromFrame(vpos({ side: 2, sizeScaled: 100 }), marks)).toBe(
      -100,
    );
  });
});

describe("positionsReconcile", () => {
  it("true when fold and venue agree on every market's signed size", () => {
    const fold = [
      { marketId: 10, signedSize: 100, entryUsd: 0.05, feesUsd: 0 },
    ];
    expect(
      positionsReconcile(fold, [vpos({ side: 1, sizeScaled: 100 })], marks),
    ).toBe(true);
  });

  it("false when the venue holds a market the ledger doesn't (shared account)", () => {
    expect(positionsReconcile([], [vpos({ sizeScaled: 100 })], marks)).toBe(
      false,
    );
  });

  it("false when sizes disagree", () => {
    const fold = [{ marketId: 10, signedSize: 50, entryUsd: 0.05, feesUsd: 0 }];
    expect(positionsReconcile(fold, [vpos({ sizeScaled: 100 })], marks)).toBe(
      false,
    );
  });

  it("true when both are flat", () => {
    expect(positionsReconcile([], [], marks)).toBe(true);
  });
});

describe("buildAggregateState", () => {
  it("reconciled down day: open notional from venue, loss from fills", () => {
    // fills: long 100 @ 0.05; venue holds long 100; mark 0.02 → unrealised −3.0
    const s = buildAggregateState({
      placedOrders: [],
      fills: [ledgerFill({ priceUsd: 0.05 })],
      venuePositions: [
        vpos({ side: 1, sizeScaled: 100, entryPriceScaled: 50_000 }),
      ],
      marks,
      nowMs: T0,
    });
    expect(s.openNotionalUsdE6).toBe(BigInt(2 * USD_SCALE)); // 100 × 0.02
    expect(s.tradesToday).toBe(1);
    expect(s.lossTodayUsdE6).toBe(BigInt(3 * USD_SCALE));
    // and it converts to a usable DayState
    expect(toDayState(s)).not.toBeNull();
  });

  it("mismatch → loss null → DayState null → caller fails closed", () => {
    const s = buildAggregateState({
      placedOrders: [],
      fills: [], // ledger empty
      venuePositions: [vpos({ side: 1, sizeScaled: 100 })], // but venue holds a position
      marks,
      nowMs: T0,
    });
    expect(s.openNotionalUsdE6).toBe(BigInt(2 * USD_SCALE)); // still real
    expect(s.lossTodayUsdE6).toBeNull();
    expect(toDayState(s)).toBeNull();
  });
});

describe("entryUsdFromFrame — the ep the frame was said not to have", () => {
  it("descales ep by price_decimals", () => {
    // 23308 at price_decimals 6 is the 0.023308 the account actually paid.
    expect(entryUsdFromFrame(POS_5273, marks)).toBeCloseTo(0.023308, 12);
  });

  it("is null when the frame omits ep, not zero", () => {
    // Zero would price a position as a total loss and quietly blow the ceiling.
    expect(
      entryUsdFromFrame(vpos({ entryPriceScaled: null }), marks),
    ).toBeNull();
  });
});

describe("unrealisedFromVenueUsd — priced from the venue, not our fold", () => {
  it("is zero at the entry price", () => {
    expect(unrealisedFromVenueUsd([POS_5273], marksAt(0.023308))).toBeCloseTo(
      0,
      9,
    );
  });

  it("a long below entry is a loss", () => {
    // 214 × (0.02 − 0.023308)
    expect(unrealisedFromVenueUsd([POS_5273], marksAt(0.02))).toBeCloseTo(
      -0.707912,
      9,
    );
  });

  it("a short above entry is a loss", () => {
    const short = { ...POS_5273, side: 2 };
    expect(unrealisedFromVenueUsd([short], marksAt(0.03))).toBeCloseTo(
      214 * -(0.03 - 0.023308),
      9,
    );
  });

  it("throws rather than skip a position with no ep", () => {
    // Skipping would under-report the day's loss and loosen the signed ceiling.
    expect(() =>
      unrealisedFromVenueUsd([vpos({ entryPriceScaled: null })], marks),
    ).toThrow(/no entry price/);
  });

  it("throws rather than skip a held market with no mark", () => {
    expect(() =>
      unrealisedFromVenueUsd([{ ...POS_5273, marketId: 99 }], marks),
    ).toThrow(/market 99/);
  });
});

describe("positionsReconcile — the price dimension, not just the size", () => {
  it("false when sizes agree but the entry prices disagree", () => {
    // THE CASE THE SIZE-ONLY CHECK LET THROUGH: a ledger holding the right
    // quantity at the wrong price yields the right notional and a wrong loss.
    const fold = [
      { marketId: 10, signedSize: 100, entryUsd: 0.05, feesUsd: 0 },
    ];
    const venue = [vpos({ sizeScaled: 100, entryPriceScaled: 50_100 })];
    expect(positionsReconcile(fold, venue, marks)).toBe(false);
  });

  it("true when the entries agree within the venue's own rounding", () => {
    const fold = [
      { marketId: 10, signedSize: 100, entryUsd: 0.05, feesUsd: 0 },
    ];
    const venue = [vpos({ sizeScaled: 100, entryPriceScaled: 50_002 })];
    expect(positionsReconcile(fold, venue, marks)).toBe(true);
  });

  it("a frame with no ep is not a mismatch — unrealised is what refuses", () => {
    const fold = [
      { marketId: 10, signedSize: 100, entryUsd: 0.05, feesUsd: 0 },
    ];
    expect(
      positionsReconcile(fold, [vpos({ entryPriceScaled: null })], marks),
    ).toBe(true);
  });

  it("reconciles the real 5273 frame against the fold that opened it", () => {
    const fold = [
      { marketId: 10, signedSize: 214, entryUsd: 0.023308, feesUsd: 0 },
    ];
    expect(positionsReconcile(fold, [POS_5273], marks)).toBe(true);
  });
});

describe("buildAggregateState — both halves, one refusal", () => {
  it("combines venue unrealised with ledger realised", () => {
    // 214 long at 0.023308, mark 0.02 → unrealised −0.707912; fee 0.1 realised.
    const s = buildAggregateState({
      placedOrders: [],
      fills: [
        ledgerFill({
          sizeUnits: 214,
          priceUsd: 0.023308,
          feeUsd: 0.1,
        }),
      ],
      venuePositions: [POS_5273],
      marks: marksAt(0.02),
      nowMs: T0,
    });
    expect(s.lossTodayUsdE6).toBe(BigInt(Math.round(0.807912 * USD_SCALE)));
  });

  it("refuses when the venue prices a position it will not name an entry for", () => {
    // Reconciled on size, so the loss is attempted — and the missing ep must
    // stop it rather than be treated as an entry of zero.
    expect(() =>
      buildAggregateState({
        placedOrders: [],
        fills: [ledgerFill({ sizeUnits: 100, priceUsd: 0.05 })],
        venuePositions: [vpos({ sizeScaled: 100, entryPriceScaled: null })],
        marks,
        nowMs: T0,
      }),
    ).toThrow(/no entry price/);
  });
});
