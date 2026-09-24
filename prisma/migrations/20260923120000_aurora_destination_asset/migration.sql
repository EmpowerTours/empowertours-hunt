-- A deposit address is identified by what it DELIVERS, not only by who owns it.
--
-- Asking Aurora for the same sender and deposit chain with a different
-- destinationAsset returns a different address (measured 2026-09-23). The old
-- unique key, (playerId, depositChain), therefore cannot hold both of a
-- hunter's addresses: issuing the second would collide with the first, and the
-- upsert would overwrite it — leaving a live address on Aurora's side that
-- nothing here could look up, and any deposit to it unattributable.
--
-- Existing rows predate the MON default and are USDC. Backfilled explicitly
-- rather than defaulted, because the default is now the other value and a row
-- labelled MON that actually delivers USDC would send a hunter's gas money
-- somewhere they cannot spend it.
ALTER TABLE "AuroraDepositAddress"
    ADD COLUMN "destinationAsset" TEXT NOT NULL DEFAULT 'MON';

UPDATE "AuroraDepositAddress" SET "destinationAsset" = 'USDC';

DROP INDEX "AuroraDepositAddress_playerId_depositChain_key";

CREATE UNIQUE INDEX "AuroraDepositAddress_playerId_depositChain_destinationAsset_key"
    ON "AuroraDepositAddress"("playerId", "depositChain", "destinationAsset");
