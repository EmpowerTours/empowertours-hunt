-- CreateTable
CREATE TABLE "Cota" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "venue" TEXT NOT NULL,
    "markets" TEXT[],
    "maxNotionalUsdE6" DECIMAL(78,0) NOT NULL,
    "maxLeverageX100" DECIMAL(78,0) NOT NULL,
    "maxDailyLossUsdE6" DECIMAL(78,0) NOT NULL,
    "maxTradesPerDay" INTEGER NOT NULL,
    "notBefore" TIMESTAMP(3) NOT NULL,
    "notAfter" TIMESTAMP(3) NOT NULL,
    "clientTs" TIMESTAMP(3) NOT NULL,
    "nonce" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "anchorTxHash" TEXT,
    "anchoredAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Cota_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Cota_digest_key" ON "Cota"("digest");

-- CreateIndex
CREATE UNIQUE INDEX "Cota_anchorTxHash_key" ON "Cota"("anchorTxHash");

-- CreateIndex
CREATE INDEX "Cota_playerId_createdAt_idx" ON "Cota"("playerId", "createdAt");

-- CreateIndex
CREATE INDEX "Cota_venue_idx" ON "Cota"("venue");

-- AddForeignKey
ALTER TABLE "Cota" ADD CONSTRAINT "Cota_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

