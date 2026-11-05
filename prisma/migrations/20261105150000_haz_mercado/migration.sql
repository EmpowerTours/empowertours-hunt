-- Haz Mercado replaces the Cotas wall game. The Cotas game and ledger tables
-- only ever existed on the unmerged cotas-game branch and its preview database
-- (play chips, no value), so they are dropped. CotasProfile stays: it is the
-- opt-in alias the weekly board shows.

-- DropForeignKey
ALTER TABLE "CotasGame" DROP CONSTRAINT IF EXISTS "CotasGame_playerId_fkey";
ALTER TABLE "CotasEvent" DROP CONSTRAINT IF EXISTS "CotasEvent_playerId_fkey";

-- DropTable
DROP TABLE IF EXISTS "CotasGame";
DROP TABLE IF EXISTS "CotasEvent";

-- CreateTable
CREATE TABLE "MercadoMatch" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "state" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "you" INTEGER,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MercadoMatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MercadoMatch_playerId_finishedAt_idx" ON "MercadoMatch"("playerId", "finishedAt");

-- CreateIndex
CREATE INDEX "MercadoMatch_finishedAt_idx" ON "MercadoMatch"("finishedAt");

-- AddForeignKey
ALTER TABLE "MercadoMatch" ADD CONSTRAINT "MercadoMatch_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One unfinished match per player, enforced by the database: two tabs pressing
-- "new match" at once get one match, not two. (Partial index: Prisma's schema
-- language cannot express it, so it lives only here.)
CREATE UNIQUE INDEX "MercadoMatch_one_active_per_player" ON "MercadoMatch"("playerId") WHERE "finishedAt" IS NULL;
