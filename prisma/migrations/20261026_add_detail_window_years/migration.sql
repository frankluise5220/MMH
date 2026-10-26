-- 明细默认观测窗口（年），0 = 不限。「设置 → 显示」里可调。
ALTER TABLE "HouseholdPreference" ADD COLUMN "detailWindowYears" INTEGER NOT NULL DEFAULT 5;
