-- 固定资产折旧台账（2026-11-18 用户裁定）
-- 设定直线法折旧后，系统按月自动生成一条折旧记录：
--   amount =（成本 − 残值）÷ 折旧月数，从购入月补记到当前月。
-- 折旧是账面价值减少，不是现金支出：本表不产生 TxRecord、不改账户余额、
-- 不进收支报表；处置/售出时以台账累计定格。
-- 全部为新增表，存量数据不需要回填。
CREATE TABLE "property_asset_depreciations" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "propertyAssetId" TEXT NOT NULL,
    "periodMonth" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "accumulatedAfter" DECIMAL(18,2) NOT NULL,
    "basisCost" DECIMAL(18,2) NOT NULL,
    "basisSalvage" DECIMAL(18,2) NOT NULL,
    "basisMonths" INTEGER NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'straight_line',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "property_asset_depreciations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "property_asset_depreciations_propertyAssetId_periodMonth_key"
    ON "property_asset_depreciations"("propertyAssetId", "periodMonth");
CREATE INDEX "property_asset_depreciations_householdId_periodMonth_idx"
    ON "property_asset_depreciations"("householdId", "periodMonth");

ALTER TABLE "property_asset_depreciations"
    ADD CONSTRAINT "property_asset_depreciations_householdId_fkey"
    FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "property_asset_depreciations"
    ADD CONSTRAINT "property_asset_depreciations_propertyAssetId_fkey"
    FOREIGN KEY ("propertyAssetId") REFERENCES "property_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
