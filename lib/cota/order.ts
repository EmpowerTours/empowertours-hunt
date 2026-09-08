// The deterministic half of Cota execution: what order to send, and whether the
// leash permits it — no keys, no network, no venue socket. Ported from Mandate's
// proven order model (src/venue.py, src/venue_client.py::order_frame), so the
// wire frame and units match the engine that has traded live.
//
// The transport (the Perpl trading WebSocket + Ed25519 sign-in) is a separate,
// stateful concern built on top of this. This layer is pure and tested, so the
// risky part rides on top of something already known-correct.

import {
  mayOpen,
  type Decision,
  type DayState,
  type EnforcedBound,
  type ProposedOrder,
} from "./enforce";
import { leverageX100, usdE6 } from "./scale";

// Perpl wire message types (src/venue.py).
export const MT_ORDER_REQUEST = 22;
export const MT_API_KEY_SIGNIN = 29;
export const MT_STATUS = 3;
export const MT_WALLET_SNAPSHOT = 19;
export const MT_ORDER_UPDATE = 24;
export const MT_FILLS_UPDATE = 25;

// Order types (src/venue.py).
export const T_OPEN_LONG = 1;
export const T_OPEN_SHORT = 2;
export const T_CLOSE_LONG = 3;
export const T_CLOSE_SHORT = 4;

export const CODE_ACCEPTED = 0;
export const SIGNIN_CONTEXT = "trading-ws-signin";

export interface Market {
  id: number;
  symbol: string;
  priceDecimals: number;
  sizeDecimals: number;
}

/**
 * The MON perpetual, pinned to Mandate's own constants (chain-verified 2026-09).
 * price_decimals 6, size_decimals 0 — MON size crosses the wire in whole units.
 */
export const MON_MARKET: Market = {
  id: 10,
  symbol: "MON",
  priceDecimals: 6,
  sizeDecimals: 0,
};

export function toPrice(m: Market, usd: number): number {
  return Math.round(usd * 10 ** m.priceDecimals);
}

export function toSize(m: Market, units: number): number {
  return Math.round(units * 10 ** m.sizeDecimals);
}

/**
 * Builder fee: basis points → Perpl's per-100k unit. 2 bps → 20 (chain-verified
 * against a live fill: bf=20 charged $0.000199 on $0.995 notional).
 */
export function bpsToBf(bps: number): number {
  return Math.round(bps * 10);
}

/**
 * Size from a target dollar notional, rounded DOWN to the market's size step.
 *
 * Rounding down (never up) keeps the order strictly UNDER the leash's notional
 * ceiling — the same rule Mandate uses. For MON (size_decimals 0) the step is
 * one whole unit: $3 at $0.0264 → 113 MON, not 114.
 */
export function sizeUnitsFromNotional(
  targetNotionalUsd: number,
  markPriceUsd: number,
  sizeDecimals: number,
): number {
  if (markPriceUsd <= 0) return 0;
  const scale = 10 ** sizeDecimals;
  const raw = targetNotionalUsd / markPriceUsd;
  return Math.floor(raw * scale) / scale;
}

export interface OpenPlan {
  orderType: typeof T_OPEN_LONG | typeof T_OPEN_SHORT;
  sizeUnits: number;
  /** Notional actually implied by the floored size — what the gate judges. */
  notionalUsd: number;
  order: ProposedOrder;
  decision: Decision;
}

/**
 * Plan an OPEN order from a target notional and gate it against the leash.
 *
 * The size is floored first, so the notional the gate sees is the notional that
 * will actually trade — never a target the flooring undershoots. Only a plan
 * whose `decision.ok` is true may go to the transport.
 */
export function planOpen(args: {
  bound: EnforcedBound;
  state: DayState;
  market: Market;
  side: "long" | "short";
  targetNotionalUsd: number;
  markPriceUsd: number;
  leverageX: number;
  nowSeconds: bigint;
}): OpenPlan {
  const { bound, state, market, side, markPriceUsd, leverageX, nowSeconds } =
    args;
  const sizeUnits = sizeUnitsFromNotional(
    args.targetNotionalUsd,
    markPriceUsd,
    market.sizeDecimals,
  );
  const notionalUsd = sizeUnits * markPriceUsd;
  const orderType = side === "long" ? T_OPEN_LONG : T_OPEN_SHORT;

  // Scale to the exact grid the leash was signed in. Round to the grid first so
  // scaleExact never rejects a floating-point artifact.
  const order: ProposedOrder = {
    venue: bound.venue,
    market: market.symbol,
    notionalUsdE6: usdE6(Math.round(notionalUsd * 1e6) / 1e6, "notional"),
    leverageX100: leverageX100(Math.round(leverageX * 100) / 100, "leverage"),
  };
  const decision = mayOpen(bound, state, order, nowSeconds);
  return { orderType, sizeUnits, notionalUsd, order, decision };
}

/**
 * The exact frame `place_order` puts on the wire (Mandate's order_frame). A
 * market order carries price 0; `lb` 0 lets the venue use the market's own
 * window. No builder_id — the venue takes it from the authenticating key.
 */
export function orderFrame(args: {
  sn: number;
  rq: number;
  market: Market;
  accountId: number;
  orderType: number;
  sizeUnits: number;
  leverageX: number;
  feeBps: number;
  priceUsd?: number;
  lastExecBlock?: number;
}): Record<string, number> {
  return {
    mt: MT_ORDER_REQUEST,
    sn: args.sn,
    rq: args.rq,
    mkt: args.market.id,
    acc: args.accountId,
    t: args.orderType,
    p: toPrice(args.market, args.priceUsd ?? 0),
    s: toSize(args.market, args.sizeUnits),
    fl: 0,
    lv: Math.round(args.leverageX * 100),
    lb: args.lastExecBlock ?? 0,
    bf: bpsToBf(args.feeBps),
  };
}
