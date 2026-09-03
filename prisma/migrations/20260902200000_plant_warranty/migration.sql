-- AlterTable
ALTER TABLE "Cache" ADD COLUMN     "suspendReason" TEXT,
ADD COLUMN     "suspendedAt" TIMESTAMP(3),
ADD COLUMN     "suspendedBy" TEXT;

-- CreateTable
CREATE TABLE "PlantWarranty" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "huntId" TEXT NOT NULL,
    "cacheId" TEXT,
    "nftContract" TEXT NOT NULL,
    "tokenId" DECIMAL(78,0) NOT NULL,
    "statement" TEXT NOT NULL,
    "statementLang" TEXT NOT NULL,
    "clientTs" TIMESTAMP(3) NOT NULL,
    "nonce" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlantWarranty_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlantWarranty_cacheId_key" ON "PlantWarranty"("cacheId");

-- CreateIndex
CREATE UNIQUE INDEX "PlantWarranty_digest_key" ON "PlantWarranty"("digest");

-- CreateIndex
CREATE INDEX "PlantWarranty_playerId_createdAt_idx" ON "PlantWarranty"("playerId", "createdAt");

-- CreateIndex
CREATE INDEX "PlantWarranty_nftContract_tokenId_idx" ON "PlantWarranty"("nftContract", "tokenId");

-- CreateIndex
CREATE INDEX "Cache_suspendedAt_idx" ON "Cache"("suspendedAt");

-- AddForeignKey
ALTER TABLE "PlantWarranty" ADD CONSTRAINT "PlantWarranty_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlantWarranty" ADD CONSTRAINT "PlantWarranty_huntId_fkey" FOREIGN KEY ("huntId") REFERENCES "Hunt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlantWarranty" ADD CONSTRAINT "PlantWarranty_cacheId_fkey" FOREIGN KEY ("cacheId") REFERENCES "Cache"("id") ON DELETE SET NULL ON UPDATE CASCADE;

