-- The hunter's signature over an autonomy grant, and the fields it covers.
--
-- A grant is the point at which delegation stops being supervised, so it is the
-- worst place in the system to be unverifiable. Stored as a column alone, anyone
-- with database write access could set it and have the legitimate server trade
-- on their behalf inside the hunter's leash. Signed, that attacker also needs
-- the hunter's key — the same bar as the Cota itself.
--
-- The signature is re-checked on every READ, not just when written, which is
-- what makes the above true rather than aspirational.
ALTER TABLE "Cota" ADD COLUMN "autonomySignature" TEXT;
ALTER TABLE "Cota" ADD COLUMN "autonomyNonce" TEXT;
ALTER TABLE "Cota" ADD COLUMN "autonomyNotAfter" TIMESTAMP(3);

CREATE UNIQUE INDEX "Cota_autonomyNonce_key" ON "Cota"("autonomyNonce");
