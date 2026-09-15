// The live day-state read, with the one repair it is allowed to make on its own.
//
// Reading the state the leash is checked against means reconciling two sources:
// the venue's position snapshot (authoritative on size) and this agent's fill
// ledger (the only source of loss). They disagree whenever a fill landed after
// the socket that placed it closed — which on Perpl is the normal case, not an
// edge one, because the gateway acks and the chain fills afterwards.
//
// aggregate.ts fails closed on that disagreement, and should. But when the
// missing size is exactly what an order THIS AGENT placed and the venue accepted
// would have produced, recording that fill is bookkeeping and not a new
// decision: the order was already gated by the leash and already acknowledged by
// the venue. So this module adopts it, at the venue's own entry price, and reads
// the state again.
//
// Anything else it will not touch. A position no pending order accounts for
// comes back as `unexplained`, the caller refuses, and adopting it takes a
// deliberate act by the hunter through /api/cota/reconcile. See adopt.ts for why
// those two cases must never collapse into one.

import { readAccountPositions } from "./venue/account-read";
import { buildAggregateState } from "./venue/aggregate";
import { toDayState, type MarkedMarket } from "./venue/account-state";
import { planAdoption, type Unexplained } from "./venue/adopt";
import { foldFills, utcDayStartMs } from "./venue/pnl";
import {
  loadFills,
  loadOrdersPlacedSince,
  loadPendingOrders,
  recordFills,
  resolveOrders,
} from "./ledger";
import type { AccountSnapshot } from "./venue/frames";
import type { DayState } from "./enforce";

export interface DayStateRead {
  /** Null when loss could not be vouched for. Null is not zero — refuse on it. */
  dayState: DayState | null;
  venueAccount: AccountSnapshot | null;
  /** Fills adopted from this agent's own pending orders during this read. */
  adoptedFills: number;
  /** Size the venue holds that nothing accounts for. Non-empty ⇒ dayState null. */
  unexplained: Unexplained[];
}

export async function readDayState(args: {
  playerId: string;
  account: string;
  apiKey: string;
  secretHex: string;
  marks: Map<number, MarkedMarket>;
  nowMs: number;
}): Promise<DayStateRead> {
  const { playerId, account, marks, nowMs } = args;

  const read = await readAccountPositions({
    apiKey: args.apiKey,
    secretHex: args.secretHex,
  });

  let fills = await loadFills(playerId, account);
  // Every order sent today, filled or not. The trades-per-day ceiling counts
  // orders SENT, so a burst of accepted-but-unfilled orders can no longer each
  // see a near-zero count and pass.
  const placedOrders = await loadOrdersPlacedSince(
    playerId,
    account,
    utcDayStartMs(nowMs),
  );
  let agg = buildAggregateState({
    fills,
    placedOrders,
    venuePositions: read.positions,
    marks,
    nowMs,
  });
  let adoptedFills = 0;
  let unexplained: Unexplained[] = [];

  if (agg.lossTodayUsdE6 === null) {
    const pending = await loadPendingOrders(playerId, account);
    const plan = planAdoption({
      fold: foldFills(fills).positions,
      venue: read.positions,
      marks,
      pending,
      nowMs,
      trust: "pending",
    });
    unexplained = plan.unexplained;

    if (plan.fills.length > 0) {
      await recordFills(playerId, account, plan.fills);
      await resolveOrders(plan.resolvedOrderIds);
      adoptedFills = plan.fills.length;
      // Re-read from the ledger rather than folding the plan in memory: what the
      // next request will see is what the database holds, and a write that
      // silently did not land must not look like a reconciled state here.
      fills = await loadFills(playerId, account);
      agg = buildAggregateState({
        fills,
        placedOrders,
        venuePositions: read.positions,
        marks,
        nowMs,
      });
    }
  }

  return {
    dayState: toDayState(agg),
    venueAccount: read.account,
    adoptedFills,
    unexplained,
  };
}
