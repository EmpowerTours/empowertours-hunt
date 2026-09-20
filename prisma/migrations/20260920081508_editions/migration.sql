/*
  Warnings:

  - You are about to drop the `DimeClaim` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "EditionKind" AS ENUM ('MUSIC', 'ART');

-- CreateEnum
CREATE TYPE "EditionTier" AS ENUM ('STANDARD', 'COLLECTOR');

-- CreateEnum
CREATE TYPE "EditionTerms" AS ENUM ('FREE', 'PURCHASE');

-- CreateEnum
CREATE TYPE "EditionClaimStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- DropForeignKey
ALTER TABLE "DimeClaim" DROP CONSTRAINT "DimeClaim_playerId_fkey";

-- DropTable
DROP TABLE "DimeClaim";

-- DropEnum
DROP TYPE "DimeClaimStatus";

-- CreateTable
CREATE TABLE "Edition" (
    "id" TEXT NOT NULL,
    "huntId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "collection" TEXT NOT NULL,
    "masterId" TEXT NOT NULL,
    "kind" "EditionKind" NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "radiusMeters" INTEGER NOT NULL DEFAULT 25,
    "tier" "EditionTier" NOT NULL,
    "terms" "EditionTerms" NOT NULL,
    "priceWei" DECIMAL(78,0),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "takenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Edition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EditionClaim" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "editionId" TEXT,
    "collection" TEXT NOT NULL,
    "masterId" TEXT NOT NULL,
    "tier" "EditionTier" NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "paidWei" DECIMAL(78,0) NOT NULL,
    "licenseId" TEXT,
    "status" "EditionClaimStatus" NOT NULL DEFAULT 'PENDING',
    "paymentTxHash" TEXT,
    "purchaseTxHash" TEXT,
    "transferTxHash" TEXT,
    "failReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EditionClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Edition_playerId_expiresAt_idx" ON "Edition"("playerId", "expiresAt");

-- CreateIndex
CREATE INDEX "Edition_huntId_createdAt_idx" ON "Edition"("huntId", "createdAt");

-- CreateIndex
CREATE INDEX "Edition_takenAt_idx" ON "Edition"("takenAt");

-- CreateIndex
CREATE UNIQUE INDEX "EditionClaim_editionId_key" ON "EditionClaim"("editionId");

-- CreateIndex
CREATE UNIQUE INDEX "EditionClaim_paymentTxHash_key" ON "EditionClaim"("paymentTxHash");

-- CreateIndex
CREATE UNIQUE INDEX "EditionClaim_purchaseTxHash_key" ON "EditionClaim"("purchaseTxHash");

-- CreateIndex
CREATE UNIQUE INDEX "EditionClaim_transferTxHash_key" ON "EditionClaim"("transferTxHash");

-- CreateIndex
CREATE INDEX "EditionClaim_status_createdAt_idx" ON "EditionClaim"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EditionClaim_playerId_collection_masterId_tier_key" ON "EditionClaim"("playerId", "collection", "masterId", "tier");

-- AddForeignKey
ALTER TABLE "Edition" ADD CONSTRAINT "Edition_huntId_fkey" FOREIGN KEY ("huntId") REFERENCES "Hunt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Edition" ADD CONSTRAINT "Edition_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EditionClaim" ADD CONSTRAINT "EditionClaim_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EditionClaim" ADD CONSTRAINT "EditionClaim_editionId_fkey" FOREIGN KEY ("editionId") REFERENCES "Edition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- An edition whose terms and price disagree must be unrepresentable, not merely
-- unusual. Written as an explicit ACCEPT of the two legal shapes rather than a
-- rejection of the illegal ones, per AGENTS.md rule 2 — so a NULL on either
-- side lands outside the constraint instead of slipping through a comparison.
ALTER TABLE "Edition" ADD CONSTRAINT "Edition_terms_price_agree" CHECK (
  ("terms" = 'FREE'     AND "priceWei" IS NULL) OR
  ("terms" = 'PURCHASE' AND "priceWei" IS NOT NULL AND "priceWei" > 0)
);
