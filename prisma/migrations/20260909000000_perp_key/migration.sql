-- Perpl trading key held server-side for the Cota agent, encrypted at rest.
CREATE TABLE "PerpKey" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "salt" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PerpKey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PerpKey_playerId_key" ON "PerpKey"("playerId");

ALTER TABLE "PerpKey" ADD CONSTRAINT "PerpKey_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
