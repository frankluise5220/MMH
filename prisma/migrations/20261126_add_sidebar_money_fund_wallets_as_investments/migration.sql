-- 侧边栏显示位置：绑定了货币基金的电子钱包是否归入「投资」分组。
-- 默认 false 保持原行为（资产 → 电子钱包）；只是显示位置开关，不改账户数据。
ALTER TABLE "HouseholdPreference"
  ADD COLUMN IF NOT EXISTS "sidebarMoneyFundWalletsAsInvestments" BOOLEAN NOT NULL DEFAULT false;
