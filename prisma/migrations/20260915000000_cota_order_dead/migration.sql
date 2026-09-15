-- An order that the gateway accepted and the chain never executed is not a
-- trade. It must not consume the leash's trades-per-day ceiling, and it must not
-- linger as something that could "explain" a position it never opened.
--
-- Account 5273 accumulated eight of these in one evening from a stale `rq`
-- (OrderDescIdTooLow) and they consumed a ceiling of five on a day when exactly
-- one order had traded. Nothing sets this automatically: it is the one flag here
-- that loosens a bound, so it is set deliberately, against evidence from the
-- venue that the order was never forwarded.
ALTER TABLE "CotaOrder" ADD COLUMN "deadAt" TIMESTAMP(3);
ALTER TABLE "CotaOrder" ADD COLUMN "deadReason" TEXT;

CREATE INDEX "CotaOrder_playerId_account_deadAt_idx" ON "CotaOrder"("playerId", "account", "deadAt");
