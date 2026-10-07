-- 2026-10-07 贷款类别（LoanCategory）
--
-- 贷款类型从「固定枚举」升级为「可管理的类别主数据」：房贷 / 消费贷 / 抵押贷 / 其他贷款
-- 是每本账簿的四个内置类别（isSystem = true），用户可以再自建（车贷、装修贷…），但每个
-- 类别必须绑定 baseType（口径），由它继承现有的贷款行为。Account.loanType 保留为口径快照，
-- Account.loanCategoryId 指向类别。
--
-- 类别 id 采用确定性命名 lc_<householdId>_<baseType>，让 PG / SQLite 两条通道以及备份恢复
-- 得到完全一致的结果（幂等）。

-- 1) 建表
CREATE TABLE IF NOT EXISTS "LoanCategory" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "baseType" "LoanType" NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isSystem" BOOLEAN NOT NULL DEFAULT false,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LoanCategory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "LoanCategory_householdId_name_key" ON "LoanCategory"("householdId", "name");
CREATE INDEX IF NOT EXISTS "LoanCategory_householdId_sortOrder_idx" ON "LoanCategory"("householdId", "sortOrder");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LoanCategory_householdId_fkey') THEN
    ALTER TABLE "LoanCategory" ADD CONSTRAINT "LoanCategory_householdId_fkey"
      FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

-- 2) Account 增加类别引用
ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "loanCategoryId" TEXT;
CREATE INDEX IF NOT EXISTS "Account_householdId_loanCategoryId_idx" ON "Account"("householdId", "loanCategoryId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Account_loanCategoryId_fkey') THEN
    ALTER TABLE "Account" ADD CONSTRAINT "Account_loanCategoryId_fkey"
      FOREIGN KEY ("loanCategoryId") REFERENCES "LoanCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

-- 3) 存量贷款口径兜底（与启动回填同一规则），保证后面能映射到类别
UPDATE "Account"
SET "loanType" = CASE WHEN "isConsumerLoan" = TRUE THEN 'consumer'::"LoanType" ELSE 'home'::"LoanType" END
WHERE "kind" = 'loan'::"AccountKind" AND "loanType" IS NULL;

-- 4) 每本账簿播种四个内置类别（幂等）
INSERT INTO "LoanCategory" ("id", "householdId", "name", "baseType", "sortOrder", "isSystem", "isActive", "createdAt", "updatedAt")
SELECT
  'lc_' || h."id" || '_' || t.base_type,
  h."id",
  t.display_name,
  t.base_type::"LoanType",
  t.sort_order,
  TRUE,
  TRUE,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Household" h
CROSS JOIN (
  VALUES
    ('房贷', 'home', 0),
    ('消费贷', 'consumer', 1),
    ('抵押贷', 'mortgage', 2),
    ('其他贷款', 'other', 3)
) AS t(display_name, base_type, sort_order)
ON CONFLICT ("id") DO NOTHING;

-- 5) 存量贷款账户映射到对应类别
UPDATE "Account" a
SET "loanCategoryId" = 'lc_' || a."householdId" || '_' || a."loanType"::text
WHERE a."kind" = 'loan'::"AccountKind"
  AND a."loanCategoryId" IS NULL
  AND a."loanType" IS NOT NULL;
