// Turn a raw venue fill into the LedgerFill the PnL fold reads. Pure — no DB, no
// socket — so the risky part (direction + descaling) is unit-tested on its own.
//
// The fill frame carries size, price and fee but NO side, so direction comes
// from the order TYPE the agent sent: opening a long or covering a short is a
// buy (+1); opening a short or closing a long is a sell (-1).

import type { Fill } from "./frames";
import type { Market } from "../order";
import {
  T_OPEN_LONG,
  T_OPEN_SHORT,
  T_CLOSE_LONG,
  T_CLOSE_SHORT,
} from "../order";
import type { LedgerFill } from "./pnl";

/** AUSD collateral is 6dp (lib/cota/deposit.ts); fees cross the wire in base units. */
export const COLLATERAL_DECIMALS = 6;

/** Direction (+1 buy / -1 sell) from the order type the agent sent. */
export function directionOfOrderType(orderType: number): 1 | -1 {
  if (orderType === T_OPEN_LONG || orderType === T_CLOSE_SHORT) return 1;
  if (orderType === T_OPEN_SHORT || orderType === T_CLOSE_LONG) return -1;
  throw new Error(`unknown order type ${orderType}`);
}

/** Normalise a venue fill + its order type into a LedgerFill. */
export function fillToLedgerFill(
  fill: Fill,
  market: Market,
  orderType: number,
  filledAtMs: number,
): LedgerFill {
  return {
    marketId: market.id,
    direction: directionOfOrderType(orderType),
    sizeUnits: fill.sizeScaled / 10 ** market.sizeDecimals,
    priceUsd: fill.priceScaled / 10 ** market.priceDecimals,
    feeUsd: Number(fill.feeBaseUnits) / 10 ** COLLATERAL_DECIMALS,
    timestampMs: filledAtMs,
    orderId: fill.orderRq,
  };
}
