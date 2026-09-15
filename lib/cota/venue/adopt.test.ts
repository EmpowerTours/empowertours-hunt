import { describe, expect, it } from "vitest";
import {
  impliedMarginalUsd,
  planAdoption,
  PENDING_MAX_AGE_MS,
  type PendingOrder,
} from "./adopt";
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

  it("will not let a STALE pending order explain a position", () => {
    // An order the venue acked and never forwarded leaves a row nothing
    // resolves. Account 5273 has two. Left unbounded, one of them would silently
    // adopt whatever the hunter opens by hand next month.
    const plan = planAdoption({
      fold: [],
      venue: [live5273()],
      marks,
      pending: [pendingBuy({ placedAtMs: NOW - PENDING_MAX_AGE_MS - 1 })],
      nowMs: NOW,
      trust: "pending",
    });
    expect(plan.fills).toEqual([]);
    expect(plan.unexplained[0].reason).toBe("no_pending_order");
  });

  it("still matches an order right at the edge of the window", () => {
    const plan = planAdoption({
      fold: [],
      venue: [live5273()],
      marks,
      pending: [pendingBuy({ placedAtMs: NOW - PENDING_MAX_AGE_MS })],
      nowMs: NOW,
      trust: "pending",
    });
    expect(plan.fills).toHaveLength(1);
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

describe("planAdoption — the hunter path attributes, it does not relabel", () => {
  // Account 5273, 2026-09-15: order 2018906983 filled 131 and its fill was
  // never recorded, so eight hours later the hunter has to adopt it. Leaving it
  // under orderId 0 counted that one trade twice — once as the still-open
  // pending row, once as the 0 — against a ceiling of five.
  const PENDING = {
    id: "row-1",
    marketId: 10,
    direction: 1 as const,
    sizeUnits: 131,
    orderId: 2018906983,
    placedAtMs: Date.UTC(2026, 8, 15, 5, 32, 19),
  };
  const EIGHT_HOURS_LATER = Date.UTC(2026, 8, 15, 13, 30, 0);

  const venueHolds131 = [
    live5273({ sizeScaled: 131, entryPriceScaled: 23159 }),
  ];

  it("writes the fill against the order that actually filled", () => {
    const plan = planAdoption({
      fold: [],
      venue: venueHolds131,
      marks,
      pending: [PENDING],
      nowMs: EIGHT_HOURS_LATER,
      trust: "hunter",
    });
    expect(plan.fills).toHaveLength(1);
    expect(plan.fills[0].orderId).toBe(2018906983);
    expect(plan.resolvedOrderIds).toEqual(["row-1"]);
  });

  it("matches a row older than the automatic window — attribution, not authorisation", () => {
    // The age cap stops a stale row AUTHORISING a silent adoption. Here a
    // person already decided; the row only says which order to credit.
    const plan = planAdoption({
      fold: [],
      venue: venueHolds131,
      marks,
      pending: [PENDING],
      nowMs: EIGHT_HOURS_LATER,
      trust: "hunter",
    });
    expect(EIGHT_HOURS_LATER - PENDING.placedAtMs).toBeGreaterThan(
      PENDING_MAX_AGE_MS,
    );
    expect(plan.fills[0].orderId).toBe(2018906983);
  });

  it("still adopts with nothing to attribute it to", () => {
    const plan = planAdoption({
      fold: [],
      venue: venueHolds131,
      marks,
      pending: [],
      nowMs: EIGHT_HOURS_LATER,
      trust: "hunter",
    });
    expect(plan.fills).toHaveLength(1);
    expect(plan.fills[0].orderId).toBe(0);
    expect(plan.resolvedOrderIds).toEqual([]);
  });

  it("the AUTOMATIC path still refuses a stale row", () => {
    // The guard that must not move: unmatched-because-old comes back
    // unexplained so a hunter decides, rather than being adopted silently.
    const plan = planAdoption({
      fold: [],
      venue: venueHolds131,
      marks,
      pending: [PENDING],
      nowMs: EIGHT_HOURS_LATER,
      trust: "pending",
    });
    expect(plan.fills).toEqual([]);
    expect(plan.unexplained[0].reason).toBe("no_pending_order");
  });
});

describe("adoption pricing — the fold must reproduce the venue's ep", () => {
  // The exact production state of account 5273 on 2026-09-15, which is what
  // broke: 214 already on the books, the venue holding 345 at a blended ep, and
  // a 131 fill missing from the ledger.
  const VENUE_SIZE = 345;
  const VENUE_EP = 0.023159;
  const HELD_SIZE = 214;
  const HELD_ENTRY = 0.023308;
  const DELTA = VENUE_SIZE - HELD_SIZE;

  it("prices the delta so the ledger averages back to ep", () => {
    const implied = impliedMarginalUsd({
      venueSize: VENUE_SIZE,
      venueEntryUsd: VENUE_EP,
      foldSize: HELD_SIZE,
      foldEntryUsd: HELD_ENTRY,
      delta: DELTA,
    });
    expect(implied).not.toBeNull();
    // Recording it at `ep` — what this code used to do — puts the fold 39.9 bps
    // away from the venue and past aggregate.ts's 10 bps check.
    const vwapIfPricedAtEp =
      (HELD_SIZE * HELD_ENTRY + DELTA * VENUE_EP) / VENUE_SIZE;
    expect(
      (Math.abs(vwapIfPricedAtEp - VENUE_EP) / VENUE_EP) * 10_000,
    ).toBeGreaterThan(10);

    // Recording it at the implied marginal reproduces ep exactly.
    const vwapIfPricedImplied =
      (HELD_SIZE * HELD_ENTRY + DELTA * (implied as number)) / VENUE_SIZE;
    expect(vwapIfPricedImplied).toBeCloseTo(VENUE_EP, 12);
  });

  it("is unchanged from ep when the ledger holds nothing", () => {
    expect(
      impliedMarginalUsd({
        venueSize: 214,
        venueEntryUsd: 0.023308,
        foldSize: 0,
        foldEntryUsd: 0,
        delta: 214,
      }),
    ).toBeCloseTo(0.023308, 12);
  });

  it("refuses rather than return a price at or below zero", () => {
    // The ledger claims to have paid more than the whole position cost. That is
    // not a rounding step, and a negative or zero entry written here would be
    // believed by every later loss read.
    expect(
      impliedMarginalUsd({
        venueSize: 345,
        venueEntryUsd: 0.023159,
        foldSize: 344,
        foldEntryUsd: 0.05,
        delta: 1,
      }),
    ).toBeNull();
  });

  it("refuses a non-finite result", () => {
    expect(
      impliedMarginalUsd({
        venueSize: 345,
        venueEntryUsd: 0.023159,
        foldSize: 0,
        foldEntryUsd: 0,
        delta: 0,
      }),
    ).toBeNull();
  });

  it("surfaces an unusable price as unexplained, not as a fill", () => {
    const plan = planAdoption({
      fold: [{ marketId: 10, signedSize: 344, entryUsd: 0.05 }],
      venue: [live5273({ sizeScaled: 345, entryPriceScaled: 23159 })],
      marks,
      pending: [pendingBuy({ sizeUnits: 1 })],
      nowMs: NOW,
      trust: "pending",
    });
    expect(plan.fills).toEqual([]);
    expect(plan.unexplained[0].reason).toBe("no_entry_price");
  });
});

describe("adoption round-trip — a second adoption must reconcile too", () => {
  // The regression in full. The first adoption always reconciled; the SECOND one
  // did not, and nothing tested it, so production went out blocked with no
  // button to press. This walks the real 5273 sequence end to end through the
  // real reconcile check.
  it("leaves the ledger reconciling after adopting onto an existing position", () => {
    const first: LedgerFill = {
      marketId: 10,
      direction: 1,
      sizeUnits: 214,
      priceUsd: 0.023308,
      feeUsd: 0.00444,
      timestampMs: NOW - 3_600_000,
      orderId: 0,
    };
    const venue = [
      live5273({ sizeScaled: 345, entryPriceScaled: 23159, feeScaled: 7113 }),
    ];

    // Where it stood: 214 on the books, 345 at the venue.
    expect(positionsReconcile(foldFills([first]).positions, venue, marks)).toBe(
      false,
    );

    const plan = planAdoption({
      fold: foldFills([first]).positions,
      venue,
      marks,
      pending: [pendingBuy({ sizeUnits: 131 })],
      nowMs: NOW,
      trust: "pending",
    });
    expect(plan.fills).toHaveLength(1);
    expect(plan.fills[0].sizeUnits).toBeCloseTo(131, 9);
    // NOT the venue's ep — that is the whole-position VWAP, and recording it
    // here is what put the ledger 39.9 bps out.
    expect(plan.fills[0].priceUsd).not.toBeCloseTo(0.023159, 6);

    const after = foldFills([first, ...plan.fills]).positions;
    expect(positionsReconcile(after, venue, marks)).toBe(true);
  });
});
