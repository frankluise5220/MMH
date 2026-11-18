-- 货币基金万份收益表：与 FundNavCache 分离，避免「净值列里存万份收益」再次放大份额。
CREATE TABLE IF NOT EXISTS "MoneyFundYield" (
    "id" TEXT NOT NULL,
    "fundCode" TEXT NOT NULL,
    "yieldDate" TIMESTAMP(3) NOT NULL,
    "incomePer10k" DECIMAL(20,6) NOT NULL,
    "sevenDayYield" DECIMAL(10,4),
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MoneyFundYield_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MoneyFundYield_fundCode_yieldDate_key" ON "MoneyFundYield"("fundCode", "yieldDate");
CREATE INDEX IF NOT EXISTS "MoneyFundYield_fundCode_yieldDate_idx" ON "MoneyFundYield"("fundCode", "yieldDate");

-- 把误存进净值缓存的货基行搬进收益表（货基的 DWJZ 就是每万份收益）。
-- 只搬属于货币基金账户的基金代码，且不覆盖已存在的收益记录。
INSERT INTO "MoneyFundYield" ("id", "fundCode", "yieldDate", "incomePer10k", "source", "createdAt", "updatedAt")
SELECT replace(gen_random_uuid()::text, '-', ''), n."fundCode", n."navDate", n."nav", 'migrated_from_nav_cache', now(), now()
FROM "FundNavCache" n
WHERE EXISTS (
  SELECT 1 FROM "FundHolding" h
  JOIN "Account" a ON a.id = h."accountId"
  WHERE h."fundCode" = n."fundCode" AND a."investProductType" = 'money'
)
ON CONFLICT ("fundCode", "yieldDate") DO NOTHING;

-- 从净值表清掉货基行：这列只应存真正的净值。
DELETE FROM "FundNavCache" n
WHERE EXISTS (
  SELECT 1 FROM "FundHolding" h
  JOIN "Account" a ON a.id = h."accountId"
  WHERE h."fundCode" = n."fundCode" AND a."investProductType" = 'money'
);

-- 历史结转行补齐已实现收益（结转金额记在 units 上，nav 恒为 1）。
-- 注意表名是 @@map 后的 fund_transactions，FundTransaction 只是 Prisma model 名。
UPDATE "fund_transactions"
SET "realizedProfit" = "units"
WHERE "source" = 'money_fund_income'
  AND "realizedProfit" IS NULL
  AND "units" IS NOT NULL;
