import { describe, expect, it } from "vitest";
import { planAdoption, type PendingOrder } from "./adopt";
import { positionsReconcile } from "./aggregate";
import { foldFills, type LedgerFill, type OpenPos } from "./pnl";
import type { OpenPositionFrame } from "./frames";
import type { MarkedMarket } from "./account-state";
import { MON_MARKET } from "../order";

const NOW = Date.UTC(2026, 8, 14, 19, 30, 0);
const marks = new Map<number, MarkedMarket>([
  [10, { market: MON_MARKET, markUsd: 0.0233 }],
]);

// Account 5273's real open position, 2026-09-14: long 214 MON, entry 23308
// (= $0.023308 at price_decimals 6), 0.004440 AUSD of fee already paid.
function live5273(over: Partial<OpenPositionFrame> = {}): OpenPositionFrame {
  return {
    pid: 6870209921025,
    marketId: 10,
    side: 1,
    sizeScaled: 214,
    leverageX100: 200,
    entryPriceScaled: 23308,
    feeScaled: 4440,
    ...over,
  };
}

function pendingBuy(over: Partial<PendingOrder> = {}): PendingOrder {
  return {
    id: "ord_1",
    marketId: 10,
    direction: 1,
    sizeUnits: 214,
    orderId: 77,
    placedAtMs: NOW - 60_000,
    ...over,
  };
}

describe("planAdoption — the agent's own order", () => {
  it("adopts a fill the placing socket missed, at the VENUE's entry price", () => {
    const plan = planAdoption({
      fold: [],
      venue: [live5273()],
      marks,
      pending: [pendingBuy()],
      nowMs: NOW,
      trust: "pending",
    });

    expect(plan.unexplained).toEqual([]);
    expect(plan.fills).toHaveLength(1);
    const f = plan.fills[0];
    expect(f.marketId).toBe(10);
    expect(f.direction).toBe(1);
    expect(f.sizeUnits).toBeCloseTo(214, 9);
    // 23308 / 1e6 — the venue's own number, not the 0.0233 mark in `marks`.
    expect(f.priceUsd).toBeCloseTo(0.023308, 12);
    expect(f.priceUsd).not.toBeCloseTo(0.0233, 12);
    expect(f.feeUsd).toBeCloseTo(0.00444, 12);
    expect(f.orderId).toBe(77);
    expect(plan.resolvedOrderIds).toEqual(["ord_1"]);
  });

  it("the adopted fill makes the ledger reconcile — the whole point", () => {
    const venue = [live5273()];
    expect(positionsReconcile([], venue, marks)).toBe(false);

    const plan = planAdoption({
      fold: [],
      venue,
      marks,
      pending: [pendingBuy()],
      nowMs: NOW,
      trust: "pending",
    });
    const { positions } = foldFills(plan.fills as LedgerFill[]);
    expect(positionsReconcile(positions, venue, marks)).toBe(true);
  });

  it("adopts only the part the ledger is short by", () => {
    const fold: OpenPos[] = [
      { marketId: 10, signedSize: 100, entryUsd: 0.0231 },
    ];
    const plan = planAdoption({
      fold,
      venue: [live5273()],
      marks,
      pending: [pendingBuy({ sizeUnits: 114 })],
      nowMs: NOW,
      trust: "pending",
    });
    expect(plan.fills[0].sizeUnits).toBeCloseTo(114, 9);
  });
});

describe("planAdoption — what it must refuse", () => {
  it("will NOT adopt a position no pending order accounts for", () => {
    // Size the hunter opened somewhere else. Adopting it silently would fold a
    // trade the agent never made into the loss figure the leash trusts.
    const plan = planAdoption({
      fold: [],
      venue: [live5273()],
      marks,
      pending: [],
      nowMs: NOW,
      trust: "pending",
    });
    expect(plan.fills).toEqual([]);
    expect(plan.unexplained).toEqual([
      { marketId: 10, deltaUnits: 214, reason: "no_pending_order" },
    ]);
  });

  it("will not match a pending order on the other side", () => {
    const plan = planAdoption({
      fold: [],
      venue: [live5273()],
      marks,
      pending: [pendingBuy({ direction: -1 })],
      nowMs: NOW,
      trust: "pending",
    });
    expect(plan.fills).toEqual([]);
    expect(plan.unexplained[0].reason).toBe("no_pending_order");
  });

  it("will not match a pending order smaller than the delta", () => {
    const plan = planAdoption({
      fold: [],
      venue: [live5273()],
      marks,
      pending: [pendingBuy({ sizeUnits: 100 })],
      nowMs: NOW,
      trust: "pending",
    });
    expect(plan.fills).toEqual([]);
    expect(plan.unexplained[0].reason).toBe("no_pending_order");
  });

  it("will NOT adopt a position the venue gives no entry price for", () => {
    // Even on the hunter's own say-so. There is no honest price to record, and
    // a made-up one goes straight into the ceiling they signed.
    for (const trust of ["pending", "hunter"] as const) {
      const plan = planAdoption({
        fold: [],
        venue: [live5273({ entryPriceScaled: null })],
        marks,
        pending: [pendingBuy()],
        nowMs: NOW,
        trust,
      });
      expect(plan.fills).toEqual([]);
      expect(plan.unexplained[0].reason).toBe("no_entry_price");
    }
  });

  it("will NOT adopt size the ledger holds and the venue does not", () => {
    // A close or a liquidation. The price left with the position.
    const plan = planAdoption({
      fold: [{ marketId: 10, signedSize: 214, entryUsd: 0.023308 }],
      venue: [],
      marks,
      pending: [],
      nowMs: NOW,
      trust: "hunter",
    });
    expect(plan.fills).toEqual([]);
    expect(plan.unexplained[0].reason).toBe("ledger_holds_more");
  });
});

describe("planAdoption — the hunter's explicit say-so", () => {
  it("adopts an unexplained position, still at the venue's entry price", () => {
    const plan = planAdoption({
      fold: [],
      venue: [live5273()],
      marks,
      pending: [],
      nowMs: NOW,
      trust: "hunter",
    });
    expect(plan.unexplained).toEqual([]);
    expect(plan.fills).toHaveLength(1);
    expect(plan.fills[0].priceUsd).toBeCloseTo(0.023308, 12);
    // Nothing of the agent's was consumed: it authorised no order here.
    expect(plan.resolvedOrderIds).toEqual([]);
    expect(plan.fills[0].orderId).toBe(0);
  });
});
