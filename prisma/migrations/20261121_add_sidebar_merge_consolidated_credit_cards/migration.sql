-- 合并账单（同机构 + 同所有人）的信用卡在侧边栏折叠成一条「机构·信用卡」。
-- 默认关闭，保持升级前每张卡各占一行的行为。
ALTER TABLE "HouseholdPreference"
  ADD COLUMN "sidebarMergeConsolidatedCreditCards" BOOLEAN NOT NULL DEFAULT false;
