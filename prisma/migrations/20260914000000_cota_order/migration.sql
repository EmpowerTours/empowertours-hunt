-- Orders this agent SENT and the venue ACCEPTED but which had not filled by the
-- time the placing socket closed. Perpl accepts on the gateway and fills on the
-- chain a moment later, so a fill can land after placeOrder has hung up; without
-- this row that fill is invisible to the ledger forever and the daily-loss read
-- fails closed on every subsequent trade. A row here is what distinguishes "a
-- position from an order we authorised under the leash" (adoptable) from "a
-- position we never made" (still fails closed, hunter must adopt explicitly).
CREATE TABLE "CotaOrder" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "marketId" INTEGER NOT NULL,
    "direction" INTEGER NOT NULL,
    "sizeUnits" DOUBLE PRECISION NOT NULL,
    "orderId" INTEGER NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CotaOrder_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CotaOrder_playerId_account_resolvedAt_idx" ON "CotaOrder"("playerId", "account", "resolvedAt");

ALTER TABLE "CotaOrder" ADD CONSTRAINT "CotaOrder_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
