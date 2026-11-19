-- 电子钱包「直接挂货基代码」的绑定区间表（2026-11-19 用户要求）
--
-- 同一只钱包可能在不同时间绑不同的货基：光在 Account 上存一个 code 会把历史覆盖掉，
-- 所以把每次绑定记成一段（fundCode + startDate + endDate）。收益按「这一天落在哪一段」
-- 取对应基金的每万份收益，换绑只关闭旧段、新增新段。
-- Account.linkedFundCode / linkedFundStartDate 保留为「当前生效段」的冗余快照，
-- 列表展示与明细过滤继续读它，由服务端在绑定/解绑时同步。
CREATE TABLE "wallet_linked_funds" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "fundCode" TEXT NOT NULL,
    "fundName" TEXT,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_linked_funds_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "wallet_linked_funds_accountId_startDate_key"
    ON "wallet_linked_funds"("accountId", "startDate");

CREATE INDEX "wallet_linked_funds_householdId_accountId_startDate_idx"
    ON "wallet_linked_funds"("householdId", "accountId", "startDate");

CREATE INDEX "wallet_linked_funds_householdId_fundCode_idx"
    ON "wallet_linked_funds"("householdId", "fundCode");

ALTER TABLE "wallet_linked_funds"
    ADD CONSTRAINT "wallet_linked_funds_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "wallet_linked_funds"
    ADD CONSTRAINT "wallet_linked_funds_householdId_fkey"
    FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 存量回填：把 Account 上已有的单段绑定（2026-11-19 早些时候上的轻量模型）写成第一段。
-- 起始日为空时退回账户创建日，避免 NOT NULL 失败。
INSERT INTO "wallet_linked_funds"
    ("id", "householdId", "accountId", "fundCode", "startDate", "createdAt", "updatedAt")
SELECT
    'wlf_' || md5(random()::text || clock_timestamp()::text || a."id"),
    a."householdId",
    a."id",
    btrim(a."linkedFundCode"),
    COALESCE(a."linkedFundStartDate", a."createdAt"),
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Account" a
WHERE a."linkedFundCode" IS NOT NULL
  AND btrim(a."linkedFundCode") <> ''
  AND NOT EXISTS (
      SELECT 1 FROM "wallet_linked_funds" w WHERE w."accountId" = a."id"
  );
