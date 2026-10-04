-- What a Kuru buy cost.
--
-- Defaults to an empty object rather than NULL: every existing row genuinely
-- has no recorded outgoing transfer, and "{}" says that without a reader having
-- to distinguish "none" from "unknown" on a column where the two coincide.
-- The backfill fills the real values in from chain.
ALTER TABLE "KuruSwap" ADD COLUMN "tokensOut" JSONB NOT NULL DEFAULT '{}';
