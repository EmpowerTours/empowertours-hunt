-- AlterTable
ALTER TABLE "Hunt" ADD COLUMN     "createdByPlayerId" TEXT;

-- CreateIndex
CREATE INDEX "Hunt_createdByPlayerId_idx" ON "Hunt"("createdByPlayerId");

-- AddForeignKey
ALTER TABLE "Hunt" ADD CONSTRAINT "Hunt_createdByPlayerId_fkey" FOREIGN KEY ("createdByPlayerId") REFERENCES "Player"("id") ON DELETE SET NULL ON UPDATE CASCADE;

