-- A player's FIRST payout used to wait for a human unconditionally.
--
-- The reasoning was sound: a first accepted position has no earlier fix to
-- check movement plausibility against, so it is the cheapest claim to fake.
-- approval.ts said so and called the rule "deliberately not configurable".
--
-- The cost of that absolutism landed on every honest newcomer. Their first
-- reward — typically one MON on the live hunt — sat in PENDING until an
-- operator was awake to approve it by hand. A real tester hit exactly that,
-- and so would a judge.
--
-- So the gate is priced rather than absolute: under this ceiling a first
-- payout may auto-approve, above it the human gate stands. It is NOT a bypass
-- — a first payout still has to clear the per-payout cap, the rolling daily
-- cap, the account-age minimum and the abuse flags like any other.
--
-- DEFAULT 0 reproduces the old behaviour exactly, so no existing hunt changes
-- by applying this migration. Setting it is a deliberate act per hunt.
ALTER TABLE "Hunt"
  ADD COLUMN "firstPayoutAutoApproveMaxWei" DECIMAL(78,0) NOT NULL DEFAULT 0;
