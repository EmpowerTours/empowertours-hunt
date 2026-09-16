-- Whether the agent may act on a leash with no hunter present, and how far.
--
-- On the Cota rather than the Player because what is authorised is "act
-- unattended up to THIS ceiling": revoking the leash then revokes autonomy with
-- it, and signing a larger leash requires consenting again instead of the agent
-- inheriting permission for a ceiling nobody agreed to run unattended.
--
-- null / 'off'  — the agent needs the hunter's session, as today
-- 'exit_only'   — may close in profit, may never open
-- 'full'        — may also open
ALTER TABLE "Cota" ADD COLUMN "autonomy" TEXT;
ALTER TABLE "Cota" ADD COLUMN "autonomyAt" TIMESTAMP(3);
