-- 固定资产折旧台账：手工登记的折损 / 减值需要一句说明（自动计提的记录留空）。
ALTER TABLE "property_asset_depreciations" ADD COLUMN "note" TEXT;
