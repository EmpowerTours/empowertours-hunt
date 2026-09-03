-- CreateTable
CREATE TABLE "CotaCheck" (
    "id" TEXT NOT NULL,
    "cotaId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "allowed" BOOLEAN NOT NULL,
    "reason" TEXT,
    "tradesToday" INTEGER NOT NULL,
    "lossTodayUsdE6" DECIMAL(78,0) NOT NULL,
    "openNotionalUsdE6" DECIMAL(78,0) NOT NULL,
    "market" TEXT,
    "notionalUsdE6" DECIMAL(78,0),
    "leverageX100" DECIMAL(78,0),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CotaCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CotaCheck_cotaId_createdAt_idx" ON "CotaCheck"("cotaId", "createdAt");

-- CreateIndex
CREATE INDEX "CotaCheck_allowed_createdAt_idx" ON "CotaCheck"("allowed", "createdAt");

-- AddForeignKey
ALTER TABLE "CotaCheck" ADD CONSTRAINT "CotaCheck_cotaId_fkey" FOREIGN KEY ("cotaId") REFERENCES "Cota"("id") ON DELETE CASCADE ON UPDATE CASCADE;

