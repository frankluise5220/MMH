-- 轻量货基模型（2026-11-19 用户裁定）：电子钱包直接挂货基代码，不再建货币基金账户。
--
-- 从 `linkedFundStartDate` 起，每天按「前一日日终余额 ÷ 10000 × 每万份收益」
-- 在本钱包记一条收益流水；余额即本金（货基面值恒 1），不产生份额与申赎联动。
-- 为空表示不自动计息（未绑定或已解绑）。
ALTER TABLE "Account" ADD COLUMN "linkedFundStartDate" TIMESTAMP(3);
