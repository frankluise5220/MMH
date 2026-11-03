-- 逆回购自定义品种（2026-11-03）：
-- 交易所 GC/R- 清单是代码常量（src/lib/repo.ts，不入库）；清单外的品种
-- （券商专属代码、协议回购等）由用户自建，按 household 隔离，
-- 逆回购借出落账时与静态清单同口径解析（code → 期限/费率）。
CREATE TABLE "RepoProductCustom" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "termDays" INTEGER NOT NULL,
    "feeRatePercent" DECIMAL(8,5),
    "note" TEXT,
    "householdId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RepoProductCustom_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RepoProductCustom_householdId_code_key" ON "RepoProductCustom"("householdId", "code");
CREATE INDEX "RepoProductCustom_householdId_idx" ON "RepoProductCustom"("householdId");

ALTER TABLE "RepoProductCustom" ADD CONSTRAINT "RepoProductCustom_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
