import { describe, expect, it } from "vitest";
import {
  buildAggregateState,
  positionsReconcile,
  signedSizeFromFrame,
} from "./aggregate";
import { toDayState, USD_SCALE, type MarkedMarket } from "./account-state";
import type { LedgerFill } from "./pnl";
import type { OpenPositionFrame } from "./frames";
import { MON_MARKET } from "../order";

const T0 = Date.UTC(2026, 8, 10, 20, 0, 0);
const marks = new Map<number, MarkedMarket>([
  [10, { market: MON_MARKET, markUsd: 0.02 }],
]);

function vpos(p: Partial<OpenPositionFrame>): OpenPositionFrame {
  return {
    pid: 1,
    marketId: 10,
    side: 1,
    sizeScaled: 100,
    leverageX100: 100,
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
    const fold = [{ marketId: 10, signedSize: 100, entryUsd: 0.05 }];
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
    const fold = [{ marketId: 10, signedSize: 50, entryUsd: 0.05 }];
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
      fills: [ledgerFill({ priceUsd: 0.05 })],
      venuePositions: [vpos({ side: 1, sizeScaled: 100 })],
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
