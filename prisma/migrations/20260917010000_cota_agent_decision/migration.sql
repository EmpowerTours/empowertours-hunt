-- What the agent has been doing, where the hunter can see it.
--
-- The agent is a poll: it wakes, decides, and answers the scheduler that called
-- it. Without this table the only record lives in a GitHub Actions log or a file
-- on a machine in someone's house, and the honest answer to "what has my agent
-- been doing" is "you cannot see".
--
-- Boring ticks are recorded too. Holding is what an agent does almost all of the
-- time, and a log that shows only trades makes a working agent look like a dead
-- one.
CREATE TABLE "CotaAgentDecision" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "cotaDigest" TEXT NOT NULL,
    "act" TEXT NOT NULL,
    "why" TEXT NOT NULL,
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "detail" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CotaAgentDecision_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CotaAgentDecision_playerId_at_idx" ON "CotaAgentDecision"("playerId", "at");
CREATE INDEX "CotaAgentDecision_cotaDigest_at_idx" ON "CotaAgentDecision"("cotaDigest", "at");

ALTER TABLE "CotaAgentDecision" ADD CONSTRAINT "CotaAgentDecision_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
