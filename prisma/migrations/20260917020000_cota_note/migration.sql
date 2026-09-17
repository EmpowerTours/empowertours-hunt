-- A hunter's private note about one leash, as ciphertext this server cannot read.
--
-- The key is derived in the browser from the passkey's PRF under a salt that is
-- not the wallet's, imported non-extractable, never transmitted. These are not
-- columns "encrypted at rest" in the usual sense, where the operator holds the
-- key and promises not to look — there is no key here to hold. No support path
-- recovers a note, no backup contains a readable one, and no instruction to the
-- operator produces the plaintext.
CREATE TABLE "CotaNote" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "cotaDigest" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CotaNote_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CotaNote_playerId_cotaDigest_key" ON "CotaNote"("playerId", "cotaDigest");

ALTER TABLE "CotaNote" ADD CONSTRAINT "CotaNote_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
