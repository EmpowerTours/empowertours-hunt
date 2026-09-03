-- CreateEnum
CREATE TYPE "RedemptionStatus" AS ENUM ('PENDING', 'SETTLED', 'VOIDED');

-- CreateTable
CREATE TABLE "Redemption" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "status" "RedemptionStatus" NOT NULL DEFAULT 'PENDING',
    "months" INTEGER NOT NULL,
    "costCreditWei" DECIMAL(78,0) NOT NULL,
    "tierPriceWei" DECIMAL(78,0) NOT NULL,
    "tier" TEXT NOT NULL,
    "ledgerEntryId" TEXT NOT NULL,
    "refundEntryId" TEXT,
    "settledBy" TEXT,
    "settledAt" TIMESTAMP(3),
    "settlementNote" TEXT,
    "voidedBy" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Redemption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Redemption_ledgerEntryId_key" ON "Redemption"("ledgerEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "Redemption_refundEntryId_key" ON "Redemption"("refundEntryId");

-- CreateIndex
CREATE INDEX "Redemption_status_createdAt_idx" ON "Redemption"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Redemption_playerId_createdAt_idx" ON "Redemption"("playerId", "createdAt");

-- AddForeignKey
ALTER TABLE "Redemption" ADD CONSTRAINT "Redemption_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

