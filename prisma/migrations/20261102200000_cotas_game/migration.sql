-- Cotas: the play-money wall game. Three new tables, all additive: nothing
-- existing is altered, so this migration cannot change Hunt or Cota behaviour.
-- Chips are play money with no value and no way out; see schema.prisma.

-- CreateTable
CREATE TABLE "CotasGame" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "state" JSONB NOT NULL,
    "cursor" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "refilledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CotasGame_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CotasEvent" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "side" INTEGER,
    "price" INTEGER,
    "entry" INTEGER,
    "qty" INTEGER,
    "pnl" BIGINT,
    "fee" BIGINT,
    "balanceAfter" BIGINT NOT NULL,
    "candleAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CotasEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CotasProfile" (
    "playerId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "aliasKey" TEXT NOT NULL,
    "listed" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CotasProfile_pkey" PRIMARY KEY ("playerId")
);

-- CreateIndex
CREATE UNIQUE INDEX "CotasGame_playerId_key" ON "CotasGame"("playerId");

-- CreateIndex
CREATE INDEX "CotasEvent_playerId_candleAt_idx" ON "CotasEvent"("playerId", "candleAt");

-- CreateIndex
CREATE INDEX "CotasEvent_candleAt_idx" ON "CotasEvent"("candleAt");

-- CreateIndex
CREATE UNIQUE INDEX "CotasProfile_aliasKey_key" ON "CotasProfile"("aliasKey");

-- AddForeignKey
ALTER TABLE "CotasGame" ADD CONSTRAINT "CotasGame_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CotasEvent" ADD CONSTRAINT "CotasEvent_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CotasProfile" ADD CONSTRAINT "CotasProfile_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

