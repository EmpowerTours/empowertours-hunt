-- Native MON received on a Kuru buy.
--
-- Nullable with no default. Every existing row gets NULL, which is the honest
-- value for them: the amount was never recorded and cannot be invented. A
-- DEFAULT '0' would have back-filled a lie into the historical rows and into
-- any future row whose decode failed.
ALTER TABLE "KuruSwap" ADD COLUMN "nativeInWei" TEXT;
