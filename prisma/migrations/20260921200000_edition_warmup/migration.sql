-- Editions were landing the moment the hunt screen opened, and landing on the
-- same work every time. Two columns, one per half of that.

-- How long after arriving before the FIRST encounter of a session may appear.
-- editionCooldownSeconds did not bound this: it is measured from the last
-- edition, so a hunter returning hours later cleared it on the first poll.
ALTER TABLE "Hunt"
  ADD COLUMN "editionFirstDelaySeconds" INTEGER NOT NULL DEFAULT 300;

-- Armed by the check-in route when a session starts (no previous verified fix,
-- or one older than maxVerifiedFixAgeSeconds). NULL is "not armed yet", which
-- the edition route reads as the clock starting now, never as permission.
ALTER TABLE "PlayerHunt"
  ADD COLUMN "editionsOpenAt" TIMESTAMP(3);
