-- 投顾组合产品分家（2026-11-03）：
-- WealthProduct 增加 productType（wealth=理财默认，advisor=投顾组合），
-- 两类产品的下拉、创建与名称查重互相隔离，不再共用一个池子。
ALTER TABLE "WealthProduct" ADD COLUMN IF NOT EXISTS "productType" TEXT NOT NULL DEFAULT 'wealth';

-- 数据回填：已被投顾组合账户交易引用过的产品划归 advisor 家族，
-- 否则用户测试期在投顾窗口创建的产品会留在理财池里。
UPDATE "WealthProduct" p
SET "productType" = 'advisor'
WHERE p."productType" = 'wealth'
  AND EXISTS (
    SELECT 1
    FROM "wealth_transactions" wt
    JOIN "Account" a ON a."id" = wt."accountId"
    WHERE wt."wealthProductId" = p."id"
      AND a."investProductType" = 'advisor'
  );
