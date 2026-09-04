-- CreateEnum
CREATE TYPE "DimeClaimStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "DimeClaim" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "licenseId" TEXT,
    "status" "DimeClaimStatus" NOT NULL DEFAULT 'PENDING',
    "purchaseTxHash" TEXT,
    "transferTxHash" TEXT,
    "failReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DimeClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DimeClaim_playerId_key" ON "DimeClaim"("playerId");

-- CreateIndex
CREATE UNIQUE INDEX "DimeClaim_purchaseTxHash_key" ON "DimeClaim"("purchaseTxHash");

-- CreateIndex
CREATE UNIQUE INDEX "DimeClaim_transferTxHash_key" ON "DimeClaim"("transferTxHash");

-- CreateIndex
CREATE INDEX "DimeClaim_status_createdAt_idx" ON "DimeClaim"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "DimeClaim" ADD CONSTRAINT "DimeClaim_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

