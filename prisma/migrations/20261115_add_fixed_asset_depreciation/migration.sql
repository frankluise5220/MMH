-- 固定资产扩展属性与折旧（2026-11-15 用户裁定）
-- productionDate / weight / weightUnit：生产日期、重量（含单位），与购买日期并列的资产属性。
-- depreciationMethod / usefulLifeMonths / salvageValue / accumulatedDepreciation：折旧口径。
--   口径实现在 src/lib/fixed-asset-depreciation.ts（none = 手填累计折旧；straight_line = 按年限直线推算）。
-- 全部新增列都有默认值或可空，存量资产不需要回填。
ALTER TABLE "property_assets" ADD COLUMN "productionDate" TIMESTAMP(3);
ALTER TABLE "property_assets" ADD COLUMN "weight" DECIMAL(18,3);
ALTER TABLE "property_assets" ADD COLUMN "weightUnit" TEXT;
ALTER TABLE "property_assets" ADD COLUMN "depreciationMethod" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "property_assets" ADD COLUMN "usefulLifeMonths" INTEGER;
ALTER TABLE "property_assets" ADD COLUMN "salvageValue" DECIMAL(18,2) NOT NULL DEFAULT 0;
ALTER TABLE "property_assets" ADD COLUMN "accumulatedDepreciation" DECIMAL(18,2) NOT NULL DEFAULT 0;
