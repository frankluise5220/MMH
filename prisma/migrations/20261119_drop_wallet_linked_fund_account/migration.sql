-- 删除旧「电子钱包绑定货基账户」模型（2026-11-19 用户裁定：旧代码不再使用，清理）。
-- 现行口径是电子钱包直接挂 6 位货基代码（Account.linkedFundCode +
-- Account.linkedFundStartDate，绑定区间在 wallet_linked_funds 表），
-- 不再建货基账户、不再做份额联动，因此这一列及其索引一并删除。
DROP INDEX IF EXISTS "Account_linkedFundAccountId_idx";

ALTER TABLE "Account"
  DROP COLUMN IF EXISTS "linkedFundAccountId";
