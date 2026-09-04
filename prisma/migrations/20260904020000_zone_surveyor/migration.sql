-- CreateEnum
CREATE TYPE "ZoneSource" AS ENUM ('ADMIN', 'OSM', 'WALKED');

-- AlterTable
ALTER TABLE "Zone" ADD COLUMN     "source" "ZoneSource" NOT NULL DEFAULT 'ADMIN',
ADD COLUMN     "surveyedByPlayerId" TEXT;

-- CreateIndex
CREATE INDEX "Zone_surveyedByPlayerId_idx" ON "Zone"("surveyedByPlayerId");

-- AddForeignKey
ALTER TABLE "Zone" ADD CONSTRAINT "Zone_surveyedByPlayerId_fkey" FOREIGN KEY ("surveyedByPlayerId") REFERENCES "Player"("id") ON DELETE SET NULL ON UPDATE CASCADE;

