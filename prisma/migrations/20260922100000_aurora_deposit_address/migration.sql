-- One Aurora Intents deposit address per hunter, per origin chain.
--
-- Aurora's persistent deposit addresses have no TTL and creation is idempotent
-- on the `sender` we send: posting the same request returns the same address
-- with alreadyExists:true. So this table caches a decision Aurora already made.
-- Losing a row is recoverable (re-issue returns the same string); writing two
-- rows for one (player, depositChain) is not, because the screen would then
-- have two answers to "where do I send money", hence the unique constraint.
CREATE TABLE "AuroraDepositAddress" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "depositChain" TEXT NOT NULL,
    "depositAddress" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "reissued" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuroraDepositAddress_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AuroraDepositAddress_playerId_depositChain_key"
    ON "AuroraDepositAddress"("playerId", "depositChain");

-- Not unique: Aurora is free to reuse an address, and a UNIQUE here would turn
-- their reuse into our 500.
CREATE INDEX "AuroraDepositAddress_depositAddress_idx"
    ON "AuroraDepositAddress"("depositAddress");

ALTER TABLE "AuroraDepositAddress"
    ADD CONSTRAINT "AuroraDepositAddress_playerId_fkey"
    FOREIGN KEY ("playerId") REFERENCES "Player"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
