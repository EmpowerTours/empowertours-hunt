-- The venue's own verdict on an order it accepted, recorded at the time.
--
-- An order whose mt 24 carried `expectsFill` has TRADED: size changed hands and
-- only the price frame is still in flight. That is evidence, where the pending
-- age cap is a heuristic — so a row carrying it stays adoptable however long it
-- takes us to read the account again, instead of expiring and sending the hunter
-- to a manual reconcile for a fill the venue already confirmed.
ALTER TABLE "CotaOrder" ADD COLUMN "venueFilledAt" TIMESTAMP(3);
ALTER TABLE "CotaOrder" ADD COLUMN "venueStatus" TEXT;
