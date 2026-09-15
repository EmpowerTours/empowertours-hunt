// The Cota fill ledger — server-side persistence behind the PnL fold. Records
// each fill the agent places and loads them back as LedgerFills. Scoped by
// (player, account) so re-enrolling on a different Perpl account never folds two
// accounts' positions together.

import { prisma } from "@/lib/db/prisma";
import type { LedgerFill, PlacedOrder } from "./venue/pnl";
import type { PendingOrder } from "./venue/adopt";
import { randomInt } from "node:crypto";

export { directionOfOrderType, fillToLedgerFill } from "./venue/normalize";

/**
 * A fresh id for one order this agent places, unique enough to count by.
 *
 * It exists because the venue's `rq` is not: placeOrder opens a socket per order
 * and sets rq=1 every time, so distinct-order counting on it always answered 1.
 * 31 bits keeps it inside the column's INTEGER and a collision only ever
 * under-counts one order against a day ceiling measured in single digits.
 */
export function newAgentOrderId(): number {
  return randomInt(1, 2_147_483_647);
}

export async function recordFill(
  playerId: string,
  account: string,
  f: LedgerFill,
): Promise<void> {
  await prisma.cotaFill.create({
    data: {
      playerId,
      account: account.toLowerCase(),
      marketId: f.marketId,
      direction: f.direction,
      sizeUnits: f.sizeUnits,
      priceUsd: f.priceUsd,
      feeUsd: f.feeUsd,
      orderId: f.orderId,
      filledAt: new Date(f.timestampMs),
    },
  });
}

/** All fills for a player's account, oldest first, as the fold expects. */
export async function loadFills(
  playerId: string,
  account: string,
): Promise<LedgerFill[]> {
  const rows = await prisma.cotaFill.findMany({
    where: { playerId, account: account.toLowerCase() },
    orderBy: { filledAt: "asc" },
  });
  return rows.map((r) => ({
    marketId: r.marketId,
    direction: r.direction === -1 ? -1 : 1,
    sizeUnits: r.sizeUnits,
    priceUsd: r.priceUsd,
    feeUsd: r.feeUsd,
    timestampMs: r.filledAt.getTime(),
    orderId: r.orderId,
  }));
}

/** Record several fills at once — the adoption path writes a batch. */
export async function recordFills(
  playerId: string,
  account: string,
  fills: LedgerFill[],
): Promise<void> {
  if (fills.length === 0) return;
  await prisma.cotaFill.createMany({
    data: fills.map((f) => ({
      playerId,
      account: account.toLowerCase(),
      marketId: f.marketId,
      direction: f.direction,
      sizeUnits: f.sizeUnits,
      priceUsd: f.priceUsd,
      feeUsd: f.feeUsd,
      orderId: f.orderId,
      filledAt: new Date(f.timestampMs),
    })),
  });
}

// --- Orders the agent placed that the venue accepted but had not filled -----
//
// Perpl fills on the chain after the gateway has acked, so placeOrder's socket
// routinely closes before the fill frame arrives. The row written here is the
// agent's own record that it authorised the order under the leash, and it is
// the only thing that later distinguishes a position this agent caused (safe to
// adopt) from one it did not (must not be adopted without the hunter).

export async function recordPlacedOrder(
  playerId: string,
  account: string,
  o: {
    marketId: number;
    direction: 1 | -1;
    sizeUnits: number;
    orderId: number;
  },
): Promise<void> {
  await prisma.cotaOrder.create({
    data: {
      playerId,
      account: account.toLowerCase(),
      marketId: o.marketId,
      direction: o.direction,
      sizeUnits: o.sizeUnits,
      orderId: o.orderId,
    },
  });
}

export async function loadPendingOrders(
  playerId: string,
  account: string,
): Promise<PendingOrder[]> {
  const rows = await prisma.cotaOrder.findMany({
    // Dead orders are excluded here too: a row that never reached the chain
    // cannot be the explanation for size the venue is holding.
    where: {
      playerId,
      account: account.toLowerCase(),
      resolvedAt: null,
      deadAt: null,
    },
    orderBy: { placedAt: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    marketId: r.marketId,
    direction: r.direction === -1 ? -1 : 1,
    sizeUnits: r.sizeUnits,
    orderId: r.orderId,
    placedAtMs: r.placedAt.getTime(),
  }));
}

/**
 * Orders this agent SENT since `sinceMs`, resolved or not — the input the
 * trades-per-day ceiling was missing.
 *
 * Deliberately not filtered by `resolvedAt`: a resolved order is one that
 * filled, and it still consumed a trade. Filtering it out would make the
 * ceiling fall again every time a fill was adopted.
 *
 * DEAD rows are excluded, and that is the only thing here that can make the
 * ceiling read lower. An order the chain never executed is not a trade — it
 * opened nothing, cost nothing and risked nothing — so counting it spends a
 * hunter's daily allowance on a non-event. Nothing marks a row dead
 * automatically; see the column's note.
 */
export async function loadOrdersPlacedSince(
  playerId: string,
  account: string,
  sinceMs: number,
): Promise<PlacedOrder[]> {
  const rows = await prisma.cotaOrder.findMany({
    where: {
      playerId,
      account: account.toLowerCase(),
      placedAt: { gte: new Date(sinceMs) },
      deadAt: null,
    },
    select: { orderId: true, placedAt: true },
  });
  return rows.map((r) => ({
    orderId: r.orderId,
    placedAtMs: r.placedAt.getTime(),
  }));
}

/** Mark orders accounted for. A resolved row is history, not a live claim. */
export async function resolveOrders(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await prisma.cotaOrder.updateMany({
    where: { id: { in: ids } },
    data: { resolvedAt: new Date() },
  });
}
