-- 承接 20261120_wallet_money_income_as_income：那一步只改了 type，这些行的
-- categoryId 原来指向 investment 型的「基金买入」（历史行被 transactions_set_investment_system_category
-- 触发器改写成了投资分类），触发器在 type 变成 income 时把投资分类清空了，编辑窗没有默认分类。
-- 这里把它们指回本账簿里 income 型的「基金收益」。
-- 只补 categoryId 为空的行：用户自己改过分类的不要覆盖。账簿没有该分类时保持空，
-- 明细仍按 source=money_fund_income 显示「收益结转」。
UPDATE "transactions" t
SET "categoryId" = c.id,
    "categoryName" = c.name
FROM "Category" c
WHERE t."source" = 'money_fund_income'
  AND t."categoryId" IS NULL
  AND c."householdId" = t."householdId"
  AND c."name" = '基金收益'
  AND c."type" = 'income';

UPDATE "transactions"
SET "type" = 'income'
WHERE "source" = 'money_fund_income'
  AND "type" = 'investment';
