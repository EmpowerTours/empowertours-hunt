-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'APPROVED', 'SENDING', 'SENT', 'FAILED', 'NEEDS_RECONCILIATION', 'VOIDED');

-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('VIEWER', 'OPERATOR', 'OWNER');

-- CreateEnum
CREATE TYPE "CreditReason" AS ENUM ('CACHE_FIND', 'ADMIN_GRANT', 'ADMIN_REVOKE', 'TURBO_REDEMPTION');

-- CreateEnum
CREATE TYPE "VerifierKind" AS ENUM ('GPS_FIND', 'GITHUB_PUSH', 'SUBMISSION', 'ADMIN_ATTEST');

-- CreateEnum
CREATE TYPE "EnrollmentStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'WITHDRAWN', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "ZoneKind" AS ENUM ('INCLUDE', 'EXCLUDE');

-- CreateTable
CREATE TABLE "Player" (
    "id" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "passkeyCredentialId" TEXT,
    "turboUsername" TEXT,
    "displayName" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "suspendedAt" TIMESTAMP(3),
    "suspendReason" TEXT,
    "creditBalanceWei" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Player_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Hunt" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "maxAccuracyM" INTEGER NOT NULL DEFAULT 30,
    "maxSpeedKmh" INTEGER NOT NULL DEFAULT 60,
    "cooldownSeconds" INTEGER NOT NULL DEFAULT 60,
    "maxClockSkewSeconds" INTEGER NOT NULL DEFAULT 120,
    "budgetCreditWei" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "spentCreditWei" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "maxFindsPerPlayer" INTEGER NOT NULL DEFAULT 0,
    "spawnEnabled" BOOLEAN NOT NULL DEFAULT false,
    "budgetMonWei" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "spentMonWei" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "spawnMinWei" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "spawnMaxWei" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "spawnMinRadiusM" INTEGER NOT NULL DEFAULT 80,
    "spawnMaxRadiusM" INTEGER NOT NULL DEFAULT 600,
    "spawnTtlSeconds" INTEGER NOT NULL DEFAULT 900,
    "spawnCooldownSeconds" INTEGER NOT NULL DEFAULT 600,
    "maxVerifiedFixAgeSeconds" INTEGER NOT NULL DEFAULT 1800,
    "spawnDailyCapWeiPerPlayer" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "autoApproveMaxWei" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "autoApproveDailyCapWei" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Hunt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Zone" (
    "id" TEXT NOT NULL,
    "huntId" TEXT NOT NULL,
    "kind" "ZoneKind" NOT NULL,
    "name" TEXT,
    "vertices" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Zone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cache" (
    "id" TEXT NOT NULL,
    "huntId" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "radiusMeters" INTEGER NOT NULL DEFAULT 25,
    "rewardCreditWei" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "label" TEXT,
    "blurb" TEXT,
    "photoCid" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayerHunt" (
    "huntId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "findCount" INTEGER NOT NULL DEFAULT 0,
    "earnedCreditWei" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "collectedMonWei" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "lastVerifiedLat" DOUBLE PRECISION,
    "lastVerifiedLng" DOUBLE PRECISION,
    "lastVerifiedAt" TIMESTAMP(3),
    "lastSpawnAt" TIMESTAMP(3),
    "firstFindAt" TIMESTAMP(3),
    "lastFindAt" TIMESTAMP(3),

    CONSTRAINT "PlayerHunt_pkey" PRIMARY KEY ("huntId","playerId")
);

-- CreateTable
CREATE TABLE "Find" (
    "id" TEXT NOT NULL,
    "huntId" TEXT NOT NULL,
    "cacheId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "foundAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "distanceMeters" DOUBLE PRECISION NOT NULL,
    "accuracyM" DOUBLE PRECISION NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "speedKmhFromLast" DOUBLE PRECISION,
    "rewardCreditSnapshot" DECIMAL(78,0) NOT NULL,

    CONSTRAINT "Find_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditLedger" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "huntId" TEXT,
    "reason" "CreditReason" NOT NULL,
    "amountWei" DECIMAL(78,0) NOT NULL,
    "balanceAfterWei" DECIMAL(78,0) NOT NULL,
    "findId" TEXT,
    "note" TEXT,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Spawn" (
    "id" TEXT NOT NULL,
    "huntId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "radiusMeters" INTEGER NOT NULL DEFAULT 25,
    "amountMonWei" DECIMAL(78,0) NOT NULL,
    "seedCommit" TEXT NOT NULL,
    "seedReveal" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "collectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Spawn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClaimAttempt" (
    "id" TEXT NOT NULL,
    "huntId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clientTs" TIMESTAMP(3) NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "accuracyM" DOUBLE PRECISION,
    "kind" TEXT NOT NULL DEFAULT 'cache',
    "accepted" BOOLEAN NOT NULL,
    "reason" TEXT,
    "detail" TEXT,
    "flagged" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ClaimAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HintRequest" (
    "id" TEXT NOT NULL,
    "huntId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "band" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HintRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payout" (
    "id" TEXT NOT NULL,
    "spawnId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "amountMonWei" DECIMAL(78,0) NOT NULL,
    "autoApproved" BOOLEAN NOT NULL DEFAULT false,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "nonce" INTEGER,
    "txHash" TEXT,
    "sentAt" TIMESTAMP(3),
    "failReason" TEXT,
    "voidReason" TEXT,
    "reconciledBy" TEXT,
    "reconciledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Track" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sequential" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Track_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackStep" (
    "id" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "verifier" "VerifierKind" NOT NULL,
    "cacheId" TEXT,
    "deliverablePath" TEXT,
    "toursAwardWei" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Enrollment" (
    "id" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "completedStepCount" INTEGER NOT NULL DEFAULT 0,
    "earnedToursWei" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "highestCompletedOrdinal" INTEGER,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "suspendedAt" TIMESTAMP(3),
    "suspendReason" TEXT,

    CONSTRAINT "Enrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StepCompletion" (
    "id" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "verifier" "VerifierKind" NOT NULL,
    "findId" TEXT,
    "commitSha" TEXT,
    "submissionCid" TEXT,
    "observedLat" DOUBLE PRECISION,
    "observedLng" DOUBLE PRECISION,
    "observedAccuracy" DOUBLE PRECISION,
    "attestedBy" TEXT,
    "note" TEXT,
    "toursAwardSnapshotWei" DECIMAL(78,0) NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StepCompletion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminUser" (
    "id" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "role" "AdminRole" NOT NULL DEFAULT 'VIEWER',
    "label" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminAction" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "detail" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Player_walletAddress_key" ON "Player"("walletAddress");

-- CreateIndex
CREATE UNIQUE INDEX "Player_passkeyCredentialId_key" ON "Player"("passkeyCredentialId");

-- CreateIndex
CREATE INDEX "Player_turboUsername_idx" ON "Player"("turboUsername");

-- CreateIndex
CREATE INDEX "Player_active_suspendedAt_idx" ON "Player"("active", "suspendedAt");

-- CreateIndex
CREATE INDEX "Hunt_active_idx" ON "Hunt"("active");

-- CreateIndex
CREATE INDEX "Zone_huntId_active_idx" ON "Zone"("huntId", "active");

-- CreateIndex
CREATE INDEX "Cache_huntId_active_idx" ON "Cache"("huntId", "active");

-- CreateIndex
CREATE INDEX "PlayerHunt_playerId_idx" ON "PlayerHunt"("playerId");

-- CreateIndex
CREATE INDEX "Find_playerId_foundAt_idx" ON "Find"("playerId", "foundAt");

-- CreateIndex
CREATE INDEX "Find_huntId_foundAt_idx" ON "Find"("huntId", "foundAt");

-- CreateIndex
CREATE UNIQUE INDEX "Find_cacheId_playerId_key" ON "Find"("cacheId", "playerId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditLedger_findId_key" ON "CreditLedger"("findId");

-- CreateIndex
CREATE INDEX "CreditLedger_playerId_createdAt_idx" ON "CreditLedger"("playerId", "createdAt");

-- CreateIndex
CREATE INDEX "CreditLedger_huntId_createdAt_idx" ON "CreditLedger"("huntId", "createdAt");

-- CreateIndex
CREATE INDEX "CreditLedger_reason_createdAt_idx" ON "CreditLedger"("reason", "createdAt");

-- CreateIndex
CREATE INDEX "Spawn_playerId_expiresAt_idx" ON "Spawn"("playerId", "expiresAt");

-- CreateIndex
CREATE INDEX "Spawn_huntId_createdAt_idx" ON "Spawn"("huntId", "createdAt");

-- CreateIndex
CREATE INDEX "Spawn_collectedAt_idx" ON "Spawn"("collectedAt");

-- CreateIndex
CREATE INDEX "ClaimAttempt_huntId_attemptedAt_idx" ON "ClaimAttempt"("huntId", "attemptedAt");

-- CreateIndex
CREATE INDEX "ClaimAttempt_playerId_attemptedAt_idx" ON "ClaimAttempt"("playerId", "attemptedAt");

-- CreateIndex
CREATE INDEX "ClaimAttempt_flagged_attemptedAt_idx" ON "ClaimAttempt"("flagged", "attemptedAt");

-- CreateIndex
CREATE INDEX "ClaimAttempt_huntId_accepted_attemptedAt_idx" ON "ClaimAttempt"("huntId", "accepted", "attemptedAt");

-- CreateIndex
CREATE INDEX "HintRequest_huntId_createdAt_idx" ON "HintRequest"("huntId", "createdAt");

-- CreateIndex
CREATE INDEX "HintRequest_playerId_createdAt_idx" ON "HintRequest"("playerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_spawnId_key" ON "Payout"("spawnId");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_txHash_key" ON "Payout"("txHash");

-- CreateIndex
CREATE INDEX "Payout_status_createdAt_idx" ON "Payout"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Payout_playerId_createdAt_idx" ON "Payout"("playerId", "createdAt");

-- CreateIndex
CREATE INDEX "Payout_status_sentAt_idx" ON "Payout"("status", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "Track_slug_key" ON "Track"("slug");

-- CreateIndex
CREATE INDEX "Track_active_idx" ON "Track"("active");

-- CreateIndex
CREATE INDEX "TrackStep_trackId_active_idx" ON "TrackStep"("trackId", "active");

-- CreateIndex
CREATE INDEX "TrackStep_cacheId_idx" ON "TrackStep"("cacheId");

-- CreateIndex
CREATE UNIQUE INDEX "TrackStep_trackId_ordinal_key" ON "TrackStep"("trackId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "TrackStep_trackId_key_key" ON "TrackStep"("trackId", "key");

-- CreateIndex
CREATE INDEX "Enrollment_playerId_status_idx" ON "Enrollment"("playerId", "status");

-- CreateIndex
CREATE INDEX "Enrollment_trackId_status_idx" ON "Enrollment"("trackId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Enrollment_trackId_playerId_key" ON "Enrollment"("trackId", "playerId");

-- CreateIndex
CREATE UNIQUE INDEX "StepCompletion_findId_key" ON "StepCompletion"("findId");

-- CreateIndex
CREATE INDEX "StepCompletion_enrollmentId_completedAt_idx" ON "StepCompletion"("enrollmentId", "completedAt");

-- CreateIndex
CREATE INDEX "StepCompletion_stepId_completedAt_idx" ON "StepCompletion"("stepId", "completedAt");

-- CreateIndex
CREATE UNIQUE INDEX "StepCompletion_enrollmentId_stepId_key" ON "StepCompletion"("enrollmentId", "stepId");

-- CreateIndex
CREATE UNIQUE INDEX "StepCompletion_stepId_commitSha_key" ON "StepCompletion"("stepId", "commitSha");

-- CreateIndex
CREATE UNIQUE INDEX "StepCompletion_stepId_submissionCid_key" ON "StepCompletion"("stepId", "submissionCid");

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_walletAddress_key" ON "AdminUser"("walletAddress");

-- CreateIndex
CREATE INDEX "AdminAction_adminId_createdAt_idx" ON "AdminAction"("adminId", "createdAt");

-- CreateIndex
CREATE INDEX "AdminAction_targetType_targetId_idx" ON "AdminAction"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "AdminAction_createdAt_idx" ON "AdminAction"("createdAt");

-- AddForeignKey
ALTER TABLE "Zone" ADD CONSTRAINT "Zone_huntId_fkey" FOREIGN KEY ("huntId") REFERENCES "Hunt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cache" ADD CONSTRAINT "Cache_huntId_fkey" FOREIGN KEY ("huntId") REFERENCES "Hunt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerHunt" ADD CONSTRAINT "PlayerHunt_huntId_fkey" FOREIGN KEY ("huntId") REFERENCES "Hunt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerHunt" ADD CONSTRAINT "PlayerHunt_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Find" ADD CONSTRAINT "Find_huntId_fkey" FOREIGN KEY ("huntId") REFERENCES "Hunt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Find" ADD CONSTRAINT "Find_cacheId_fkey" FOREIGN KEY ("cacheId") REFERENCES "Cache"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Find" ADD CONSTRAINT "Find_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_huntId_fkey" FOREIGN KEY ("huntId") REFERENCES "Hunt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Spawn" ADD CONSTRAINT "Spawn_huntId_fkey" FOREIGN KEY ("huntId") REFERENCES "Hunt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Spawn" ADD CONSTRAINT "Spawn_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimAttempt" ADD CONSTRAINT "ClaimAttempt_huntId_fkey" FOREIGN KEY ("huntId") REFERENCES "Hunt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimAttempt" ADD CONSTRAINT "ClaimAttempt_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HintRequest" ADD CONSTRAINT "HintRequest_huntId_fkey" FOREIGN KEY ("huntId") REFERENCES "Hunt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HintRequest" ADD CONSTRAINT "HintRequest_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_spawnId_fkey" FOREIGN KEY ("spawnId") REFERENCES "Spawn"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackStep" ADD CONSTRAINT "TrackStep_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackStep" ADD CONSTRAINT "TrackStep_cacheId_fkey" FOREIGN KEY ("cacheId") REFERENCES "Cache"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StepCompletion" ADD CONSTRAINT "StepCompletion_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "Enrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StepCompletion" ADD CONSTRAINT "StepCompletion_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "TrackStep"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StepCompletion" ADD CONSTRAINT "StepCompletion_findId_fkey" FOREIGN KEY ("findId") REFERENCES "Find"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAction" ADD CONSTRAINT "AdminAction_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

