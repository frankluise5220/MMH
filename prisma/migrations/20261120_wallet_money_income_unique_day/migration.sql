-- 一只电子钱包一天只允许一条货基收益，**与基金代码无关**。
--
-- 钱包里的钱一天只能呆在一只货基里：换绑基金时如果新旧两段的日期有一天重叠，
-- 「日期|基金代码」这种幂等键会把同一天结出两条收益（2026-11-20 用户在明细里
-- 看到的重复收益）。代码层已改成按日期去重 + skipDuplicates，这条部分唯一索引
-- 是并发的最后一道闸（多个实例/手工重算同时补历史时，先查后写都看不到对方未提交的行）。
--
-- 软删行不进索引：同一天可以保留被重算/换绑删掉的历史收益行。

-- 建索引前先清掉现存重复（保留同一天最新写入的那一条），否则建索引会失败。
DELETE FROM "transactions" t
USING "transactions" keep
WHERE t."source" = 'money_fund_income'
  AND keep."source" = 'money_fund_income'
  AND t."accountId" = keep."accountId"
  AND t."date" = keep."date"
  AND t."deletedAt" IS NULL
  AND keep."deletedAt" IS NULL
  AND (keep."createdAt", keep."id") > (t."createdAt", t."id");

CREATE UNIQUE INDEX IF NOT EXISTS "transactions_money_income_account_day_key"
ON "transactions" ("accountId", "date")
WHERE "source" = 'money_fund_income' AND "deletedAt" IS NULL;
