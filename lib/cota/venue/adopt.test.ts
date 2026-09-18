import { describe, expect, it } from "vitest";
import {
  closePriceFromRealised,
  impliedMarginalUsd,
  planAdoption,
  remainingFeeUsd,
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
    entryResidueQ16: null,
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
    venueConfirmedFill: false,
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
      { marketId: 10, signedSize: 100, entryUsd: 0.0231, feesUsd: 0 },
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

  it("will NOT adopt size the ledger holds when nothing explains it", () => {
    // A position that vanished with no order of ours behind it is a
    // liquidation. It is still refused — the reason is now the more accurate
    // "no_pending_order", because a close WITH one of our orders behind it can
    // be priced from the venue's realised total. See the close suite below.
    const plan = planAdoption({
      fold: [{ marketId: 10, signedSize: 214, entryUsd: 0.023308, feesUsd: 0 }],
      venue: [],
      marks,
      pending: [],
      nowMs: NOW,
      trust: "hunter",
    });
    expect(plan.fills).toEqual([]);
    expect(plan.unexplained[0].reason).toBe("no_pending_order");
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
    venueConfirmedFill: false,
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
      fold: [{ marketId: 10, signedSize: 344, entryUsd: 0.05, feesUsd: 0 }],
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

describe("adoption fees — the venue's figure is cumulative, not per fill", () => {
  it("attributes only what the ledger has not booked yet", () => {
    // 5273 exactly: the venue charged 0.007113 across the position, the ledger
    // already holds 0.004440 from the first fill.
    expect(remainingFeeUsd(0.007113, 0.00444)).toBeCloseTo(0.002673, 12);
  });

  it("attributes the whole figure when the ledger holds nothing", () => {
    expect(remainingFeeUsd(0.007113, 0)).toBeCloseTo(0.007113, 12);
  });

  it("clamps at zero rather than crediting a fee back", () => {
    // The ledger already holds more than the venue says it charged. There is
    // nothing further to attribute, and the excess is already counted against
    // the day — clamping declines to add, it never subtracts.
    expect(remainingFeeUsd(0.007113, 0.02)).toBe(0);
  });

  it("treats an absent or nonsense position fee as nothing to attribute", () => {
    expect(remainingFeeUsd(0, 0.00444)).toBe(0);
    expect(remainingFeeUsd(Number.NaN, 0.00444)).toBe(0);
  });

  it("adopting onto an existing position books the DIFFERENCE, not the total", () => {
    // The regression: this used to write 0.007113 on top of the 0.004440
    // already there, so 5273 claimed 0.011553 against the venue's 0.007113.
    const first: LedgerFill = {
      marketId: 10,
      direction: 1,
      sizeUnits: 214,
      priceUsd: 0.023308,
      feeUsd: 0.00444,
      timestampMs: NOW - 3_600_000,
      orderId: 0,
    };
    const plan = planAdoption({
      fold: foldFills([first]).positions,
      venue: [
        live5273({ sizeScaled: 345, entryPriceScaled: 23159, feeScaled: 7113 }),
      ],
      marks,
      pending: [pendingBuy({ sizeUnits: 131 })],
      nowMs: NOW,
      trust: "pending",
    });
    expect(plan.fills[0].feeUsd).toBeCloseTo(0.002673, 12);

    const totalFees = [first, ...plan.fills].reduce((a, f) => a + f.feeUsd, 0);
    expect(totalFees).toBeCloseTo(0.007113, 12); // === the venue's own tf
  });
});

describe("foldFills — fees follow the open run", () => {
  const f = (p: Partial<LedgerFill>): LedgerFill => ({
    marketId: 10,
    direction: 1,
    sizeUnits: 100,
    priceUsd: 0.02,
    feeUsd: 0,
    timestampMs: NOW,
    orderId: 1,
    ...p,
  });

  it("accumulates across adds", () => {
    const { positions } = foldFills([
      f({ feeUsd: 0.01, timestampMs: NOW }),
      f({ feeUsd: 0.02, timestampMs: NOW + 1 }),
    ]);
    expect(positions[0].feesUsd).toBeCloseTo(0.03, 12);
  });

  it("accumulates across a partial reduce — the venue charges the same position", () => {
    const { positions } = foldFills([
      f({ feeUsd: 0.01, timestampMs: NOW }),
      f({ direction: -1, sizeUnits: 40, feeUsd: 0.02, timestampMs: NOW + 1 }),
    ]);
    expect(positions[0].signedSize).toBeCloseTo(60, 9);
    expect(positions[0].feesUsd).toBeCloseTo(0.03, 12);
  });

  it("forgets the run's fees once the position is flat", () => {
    const { positions } = foldFills([
      f({ feeUsd: 0.01, timestampMs: NOW }),
      f({ direction: -1, feeUsd: 0.02, timestampMs: NOW + 1 }),
      f({ feeUsd: 0.005, timestampMs: NOW + 2 }),
    ]);
    // A new run: only its own fee, not the closed run's.
    expect(positions[0].feesUsd).toBeCloseTo(0.005, 12);
  });

  it("restarts on a flip through zero", () => {
    const { positions } = foldFills([
      f({ feeUsd: 0.01, timestampMs: NOW }),
      f({ direction: -1, sizeUnits: 150, feeUsd: 0.02, timestampMs: NOW + 1 }),
    ]);
    expect(positions[0].signedSize).toBeCloseTo(-50, 9);
    expect(positions[0].feesUsd).toBeCloseTo(0.02, 12);
  });
});

describe("a fill the venue confirmed does not expire", () => {
  // The trap this closes: the order filled, the venue said so on mt 24, and the
  // fill frame arrived after the socket closed. If the hunter does not come back
  // within PENDING_MAX_AGE_MS, the row stops being able to explain the position
  // and they are sent to a manual reconcile — for a fill the venue told us about
  // at the time. Recency is a heuristic; the venue's verdict is evidence.
  const LONG_AFTER = NOW + PENDING_MAX_AGE_MS * 20;

  it("adopts automatically however long ago it was placed", () => {
    const plan = planAdoption({
      fold: [],
      venue: [live5273()],
      marks,
      pending: [pendingBuy({ venueConfirmedFill: true })],
      nowMs: LONG_AFTER,
      trust: "pending",
    });
    expect(plan.unexplained).toEqual([]);
    expect(plan.fills).toHaveLength(1);
    expect(plan.resolvedOrderIds).toEqual(["ord_1"]);
  });

  it("an UNCONFIRMED row of the same age still expires", () => {
    // The exemption must come from the verdict, not from having loosened the
    // cap for everyone.
    const plan = planAdoption({
      fold: [],
      venue: [live5273()],
      marks,
      pending: [pendingBuy({ venueConfirmedFill: false })],
      nowMs: LONG_AFTER,
      trust: "pending",
    });
    expect(plan.fills).toEqual([]);
    expect(plan.unexplained[0].reason).toBe("no_pending_order");
  });

  it("confirmation does not excuse a mismatched market, side or size", () => {
    // It exempts the row from the CLOCK and nothing else. A confirmed fill on
    // the other side is still not an explanation for this position.
    for (const over of [
      { direction: -1 as const },
      { marketId: 99 },
      { sizeUnits: 1 },
    ]) {
      const plan = planAdoption({
        fold: [],
        venue: [live5273()],
        marks,
        pending: [pendingBuy({ venueConfirmedFill: true, ...over })],
        nowMs: LONG_AFTER,
        trust: "pending",
      });
      expect(plan.fills).toEqual([]);
    }
  });
});

describe("a close we never saw, priced from the venue's realised PnL", () => {
  // Account 5273's actual situation on 2026-09-18: the hunter pressed Close
  // all, the venue filled it, the placing socket missed the fill, and the
  // ledger was left holding 576 units of a position that no longer exists.
  // Before this, planAdoption refused — "a closed position cannot be priced" —
  // and left them unable to trade with no button to press.
  const ENTRY_5273 = 0.023158014;
  const heldLong: OpenPos[] = [
    { marketId: 10, signedSize: 576, entryUsd: ENTRY_5273, feesUsd: 0.011553 },
  ];
  const closeOrder = pendingBuy({
    direction: -1,
    sizeUnits: 576,
    orderId: 1698673214,
    venueConfirmedFill: true,
  });

  it("records the close and flattens the ledger", () => {
    const plan = planAdoption({
      fold: heldLong,
      venue: [], // the venue reports nothing open
      marks,
      pending: [closeOrder],
      nowMs: NOW,
      trust: "pending",
      // trp moved -0.015442 -> +0.354368; our ledger had folded only the
      // opening fees, -0.011553.
      realised: { venueUsd: 0.354368, ledgerUsd: -0.011553 },
    });

    expect(plan.unexplained).toEqual([]);
    expect(plan.fills).toHaveLength(1);
    const f = plan.fills[0];
    expect(f.direction).toBe(-1);
    expect(f.sizeUnits).toBeCloseTo(576, 9);
    expect(f.feeUsd).toBe(0); // trp is already net of fees

    // The opening fills that produced the 576, plus the adopted close.
    const opens: LedgerFill[] = [
      {
        marketId: 10,
        direction: 1,
        sizeUnits: 576,
        priceUsd: ENTRY_5273,
        feeUsd: 0.011553,
        timestampMs: NOW - 86_400_000,
        orderId: 1,
      },
    ];
    const after = foldFills([...opens, f]).positions;
    expect(after).toEqual([]); // flat, matching the venue
    expect(positionsReconcile(after, [], marks)).toBe(true);
  });

  it("reproduces the venue's realised total exactly", () => {
    // The property that matters: after adopting, the ledger's realised PnL
    // equals trp. A close priced "plausibly" but disagreeing with the venue
    // would corrupt every later loss read.
    const realisedDelta = 0.354368 - -0.011553;
    const price = closePriceFromRealised({
      foldEntryUsd: ENTRY_5273,
      foldSignedSize: 576,
      realisedDeltaUsd: realisedDelta,
    })!;
    expect(576 * (price - ENTRY_5273)).toBeCloseTo(realisedDelta, 9);
  });

  it("a short realises as the price FALLS", () => {
    const price = closePriceFromRealised({
      foldEntryUsd: 0.02,
      foldSignedSize: -100, // short
      realisedDeltaUsd: 0.5, // profitable
    })!;
    expect(price).toBeLessThan(0.02);
    expect(100 * (0.02 - price)).toBeCloseTo(0.5, 9);
  });

  it("refuses without a realised total rather than guessing", () => {
    const plan = planAdoption({
      fold: heldLong,
      venue: [],
      marks,
      pending: [closeOrder],
      nowMs: NOW,
      trust: "pending",
    });
    expect(plan.fills).toEqual([]);
    expect(plan.unexplained[0].reason).toBe("no_realised_total");
  });

  it("refuses when no order of ours explains the disappearance", () => {
    // A position that vanished with no order of ours behind it is a
    // liquidation, and adopting it silently would hide that from the hunter.
    const plan = planAdoption({
      fold: heldLong,
      venue: [],
      marks,
      pending: [],
      nowMs: NOW,
      trust: "pending",
      realised: { venueUsd: -5, ledgerUsd: -0.011553 },
    });
    expect(plan.fills).toEqual([]);
    expect(plan.unexplained[0].reason).toBe("no_pending_order");
  });

  it("the AUTOMATIC path needs the venue to have confirmed the close", () => {
    // An order we sent and the venue never acknowledged is not an explanation
    // for a position that vanished. Unconfirmed, the disappearance could as
    // easily be a liquidation — and adopting it unattended would write a
    // realised PnL the hunter never agreed to and hide the liquidation.
    const unconfirmed = { ...closeOrder, venueConfirmedFill: false };
    const plan = planAdoption({
      fold: heldLong,
      venue: [],
      marks,
      pending: [unconfirmed],
      nowMs: NOW,
      trust: "pending",
      realised: { venueUsd: 0.354368, ledgerUsd: -0.011553 },
    });
    expect(plan.fills).toEqual([]);
    expect(plan.unexplained[0].reason).toBe("no_pending_order");
  });

  it("but the HUNTER path may adopt it, because a person is asking", () => {
    // Same row, same uncertainty — the difference is that someone has looked at
    // their own account and said yes. That is the whole distinction this module
    // is built around.
    const unconfirmed = { ...closeOrder, venueConfirmedFill: false };
    const plan = planAdoption({
      fold: heldLong,
      venue: [],
      marks,
      pending: [unconfirmed],
      nowMs: NOW,
      trust: "hunter",
      realised: { venueUsd: 0.354368, ledgerUsd: -0.011553 },
    });
    expect(plan.fills).toHaveLength(1);
  });

  it("refuses a negative or impossible price", () => {
    // A realised loss larger than the whole position was worth.
    expect(
      closePriceFromRealised({
        foldEntryUsd: 0.02,
        foldSignedSize: 100,
        realisedDeltaUsd: -100,
      }),
    ).toBeNull();
  });
});
