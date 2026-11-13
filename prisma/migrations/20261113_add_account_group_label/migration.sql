-- 账户自定义分组标签（2026-11-13）：用户自己起的分类名，侧边栏 / 账户下拉可按它分组。
-- 与 groupId → AccountGroup（所有人 / 归属人分组）无关，纯展示用的自由文本。
-- 可空：存量账户一律「未分组」，无需回填。
ALTER TABLE "Account"
  ADD COLUMN IF NOT EXISTS "accountGroup" TEXT;

-- 账户下拉的分组维度（2026-11-13）：owner（默认，历史行为）| accountGroup | institution。
-- 带默认值，存量账簿保持「按所有人分组」，行为不变。
ALTER TABLE "HouseholdPreference"
  ADD COLUMN IF NOT EXISTS "accountDropdownGroupBy" TEXT NOT NULL DEFAULT 'owner';
