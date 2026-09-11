-- Normalised Cota agent fills — the ledger the fills-VWAP daily-loss read folds
-- (lib/cota/venue/pnl.ts). Perpl sends no entry/PnL, so this table is the
-- entry-price record the daily-loss stop reconstructs from.
CREATE TABLE "CotaFill" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "marketId" INTEGER NOT NULL,
    "direction" INTEGER NOT NULL,
    "sizeUnits" DOUBLE PRECISION NOT NULL,
    "priceUsd" DOUBLE PRECISION NOT NULL,
    "feeUsd" DOUBLE PRECISION NOT NULL,
    "orderId" INTEGER NOT NULL,
    "filledAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CotaFill_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CotaFill_playerId_account_filledAt_idx" ON "CotaFill"("playerId", "account", "filledAt");

ALTER TABLE "CotaFill" ADD CONSTRAINT "CotaFill_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
