-- 债券独立化：把债券从「理财 bond 路线」拆成独立实现。
-- 背景：债券功能在 0.1.62 未发布，线上无存量数据；此迁移同时搬迁开发期产生的测试数据。
-- 参照样板：存款（DepositProduct / DepositTransaction / deposit* / DepositShell）。
-- 保留项：FundProductType 的 'bond'（债券账户类型）与 FundSubtype 的 'write_off'（债券核销）
--         仍在使用，PostgreSQL 也不支持删除枚举值，故不动这两个枚举。

-- 1. 债券产品主数据表
CREATE TABLE "BondProduct" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shortName" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "annualRate" DECIMAL(10,6),
    "termDays" INTEGER,
    "maturityDate" TIMESTAMP(3),
    "payoutFrequency" TEXT,
    "interestCalcBasis" TEXT,
    "firstPayoutDate" TIMESTAMP(3),
    "note" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "householdId" TEXT NOT NULL,
    "institutionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BondProduct_pkey" PRIMARY KEY ("id")
);

-- 2. 债券交易表（对齐 deposit_transactions，不含基金专属 units / nav）
CREATE TABLE "bond_transactions" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "cashAccountId" TEXT,
    "cashEntryId" TEXT,
    "bondProductId" TEXT,
    "productName" TEXT,
    "action" "FundSubtype" NOT NULL DEFAULT 'buy',
    "source" TEXT DEFAULT 'manual',
    "entryOrigin" TEXT DEFAULT 'manual',
    "tradeDate" TIMESTAMP(3) NOT NULL,
    "confirmDate" TIMESTAMP(3),
    "arrivalDate" TIMESTAMP(3),
    "grossAmount" DECIMAL(18,2) NOT NULL,
    "arrivalAmount" DECIMAL(18,2),
    "interest" DECIMAL(18,2),
    "fee" DECIMAL(18,2),
    "annualRate" DECIMAL(10,6),
    "realizedProfit" DECIMAL(18,2),
    "note" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bond_transactions_pkey" PRIMARY KEY ("id")
);

-- 3. 索引
CREATE INDEX "BondProduct_householdId_isActive_name_idx" ON "BondProduct"("householdId", "isActive", "name");
CREATE INDEX "BondProduct_institutionId_idx" ON "BondProduct"("institutionId");
CREATE UNIQUE INDEX "BondProduct_householdId_institutionId_name_key" ON "BondProduct"("householdId", "institutionId", "name");
CREATE UNIQUE INDEX "bond_transactions_cashEntryId_key" ON "bond_transactions"("cashEntryId");
CREATE INDEX "bond_transactions_householdId_accountId_tradeDate_idx" ON "bond_transactions"("householdId", "accountId", "tradeDate");
CREATE INDEX "bond_transactions_cashAccountId_tradeDate_idx" ON "bond_transactions"("cashAccountId", "tradeDate");
CREATE INDEX "bond_transactions_bondProductId_tradeDate_idx" ON "bond_transactions"("bondProductId", "tradeDate");
CREATE INDEX "bond_transactions_deletedAt_idx" ON "bond_transactions"("deletedAt");

-- 4. 新列：业务关联表指向债券交易；流水表新增债券专用字段
ALTER TABLE "entry_business_links" ADD COLUMN "bondTransactionId" TEXT;
CREATE INDEX "entry_business_links_bondTransactionId_idx" ON "entry_business_links"("bondTransactionId");

ALTER TABLE "transactions"
  ADD COLUMN "bondProductId" TEXT,
  ADD COLUMN "bondSubtype" "FundSubtype",
  ADD COLUMN "bondName" TEXT,
  ADD COLUMN "bondAnnualRate" DECIMAL(10,6),
  ADD COLUMN "bondInterest" DECIMAL(18,2),
  ADD COLUMN "bondArrivalDate" TIMESTAMP(3),
  ADD COLUMN "bondConfirmDate" TIMESTAMP(3),
  ADD COLUMN "bondFee" DECIMAL(18,2);
CREATE INDEX "transactions_bondProductId_idx" ON "transactions"("bondProductId");

-- 5. 外键
ALTER TABLE "BondProduct" ADD CONSTRAINT "BondProduct_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BondProduct" ADD CONSTRAINT "BondProduct_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "bond_transactions" ADD CONSTRAINT "bond_transactions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bond_transactions" ADD CONSTRAINT "bond_transactions_cashAccountId_fkey" FOREIGN KEY ("cashAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "bond_transactions" ADD CONSTRAINT "bond_transactions_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bond_transactions" ADD CONSTRAINT "bond_transactions_bondProductId_fkey" FOREIGN KEY ("bondProductId") REFERENCES "BondProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "entry_business_links" ADD CONSTRAINT "entry_business_links_bondTransactionId_fkey" FOREIGN KEY ("bondTransactionId") REFERENCES "bond_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_bondProductId_fkey" FOREIGN KEY ("bondProductId") REFERENCES "BondProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 6. 数据搬迁
-- 债单沿用原 id：计划行 id 前缀 bondm_<productId> / bondi_<productId> 无需改动。
INSERT INTO "BondProduct" (
  "id", "name", "shortName", "currency", "annualRate", "termDays", "maturityDate",
  "payoutFrequency", "interestCalcBasis", "firstPayoutDate", "note", "isActive",
  "householdId", "institutionId", "createdAt", "updatedAt"
)
SELECT
  "id", "name", "shortName", "currency", "annualRate", "termDays", "maturityDate",
  "payoutFrequency", "interestCalcBasis", "firstPayoutDate", "note", "isActive",
  "householdId", "institutionId", "createdAt", "updatedAt"
FROM "WealthProduct"
WHERE "productType" = 'bond';

-- 债券交易沿用原 id：EntryBusinessLink 的 cashEntryId 与 TxRecord 关联保持不变。
INSERT INTO "bond_transactions" (
  "id", "householdId", "accountId", "cashAccountId", "cashEntryId", "bondProductId", "productName",
  "action", "source", "entryOrigin", "tradeDate", "confirmDate", "arrivalDate", "grossAmount",
  "arrivalAmount", "interest", "fee", "annualRate", "realizedProfit", "note", "deletedAt",
  "createdAt", "updatedAt"
)
SELECT
  "id", "householdId", "accountId", "cashAccountId", "cashEntryId", "wealthProductId", "productName",
  "action", "source", "entryOrigin", "tradeDate", "confirmDate", "arrivalDate", "grossAmount",
  "arrivalAmount", "interest", "fee", "annualRate", "realizedProfit", "note", "deletedAt",
  "createdAt", "updatedAt"
FROM "wealth_transactions"
WHERE "wealthProductId" IN (SELECT "id" FROM "BondProduct");

-- 业务关联改指向债券交易
UPDATE "entry_business_links"
SET "bondTransactionId" = "wealthTransactionId", "wealthTransactionId" = NULL
WHERE "wealthTransactionId" IN (SELECT "id" FROM "bond_transactions");

-- 流水表：债券专用字段落值，并清空原先借用的 fund* / deposit* 字段
UPDATE "transactions"
SET
  "bondProductId"     = "wealthProductId",
  "bondSubtype"       = "fundSubtype",
  "bondName"          = "fundName",
  "bondAnnualRate"    = "depositAnnualRate",
  "bondInterest"      = "depositInterest",
  "bondArrivalDate"   = "fundArrivalDate",
  "bondConfirmDate"   = "fundConfirmDate",
  "bondFee"           = "fundFee",
  "wealthProductId"   = NULL,
  "fundCode"          = NULL,
  "fundSubtype"       = NULL,
  "fundName"          = NULL,
  "fundUnits"         = NULL,
  "fundNav"           = NULL,
  "fundArrivalAmount" = NULL,
  "fundArrivalDate"   = NULL,
  "fundConfirmDate"   = NULL,
  "fundFee"           = NULL,
  "depositAnnualRate" = NULL,
  "depositInterest"   = NULL
WHERE "fundProductType" = 'bond';

-- 7. 清理：债券数据从理财表移除，WealthProduct 回归纯普通理财
DELETE FROM "wealth_transactions" WHERE "id" IN (SELECT "id" FROM "bond_transactions");
DELETE FROM "WealthProduct" WHERE "id" IN (SELECT "id" FROM "BondProduct");

ALTER TABLE "WealthProduct"
  DROP COLUMN "firstPayoutDate",
  DROP COLUMN "interestCalcBasis",
  DROP COLUMN "maturityDate",
  DROP COLUMN "payoutFrequency",
  DROP COLUMN "productType";

DROP TYPE "WealthProductType";
