// The Cota fill ledger — server-side persistence behind the PnL fold. Records
// each fill the agent places and loads them back as LedgerFills. Scoped by
// (player, account) so re-enrolling on a different Perpl account never folds two
// accounts' positions together.

import { prisma } from "@/lib/db/prisma";
import type { LedgerFill } from "./venue/pnl";

export { directionOfOrderType, fillToLedgerFill } from "./venue/normalize";

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
