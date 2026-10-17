-- 基金资金腿「出处 + 去处」统一（2026-10-17 用户裁定）。
--
-- 规则：每一笔基金资金腿都必须同时记清付款方与收款方。
--   买入（现金流出）: accountId = 现金账户, toAccountId = 基金账户, amount < 0
--   退款（现金流入）: accountId = 基金账户,  toAccountId = 现金账户, amount > 0
--   赎回/分红同理走「基金账户 → 现金账户」。
-- 这与库里绝大多数退款腿（66/68）以及全部赎回腿的既有形态一致；
-- 少数历史数据写成单腿（`toAccountId` 为空），本次一次性补齐。
--
-- 幂等：补完后条件不再命中，重复执行是 no-op。
--
-- 余额影响：无。资金账户侧余额在 `toAccountId` 命中时取 ABS(amount)，
-- 与原先在 `accountId` 侧取 amount 的数值相同；基金/投资账户余额走
-- `Account.balance` 缓存，不按流水折叠。
--
-- PostgreSQL-compatible（dev / docker migrate-deploy 路径）。
-- Docker 通道走 `prisma db push`，等价实现见 `scripts/docker-entrypoint.sh`
-- 的 `migrate_fund_cash_leg_accounts`；SQLite 侧见
-- `scripts/build-fnos-package.cjs` 的 MIGRATIONS 条目同名 version。

-- 1) 退款资金腿：资金账户 → 基金账户 改为 基金账户 → 资金账户（两侧都落库）。
UPDATE "transactions" t
   SET "accountId"     = ft."fundAccountId",
       "accountName"   = COALESCE(NULLIF(fa."name", ''), t."accountName", ''),
       "toAccountId"   = ft."cashAccountId",
       "toAccountName" = COALESCE(NULLIF(ca."name", ''), t."accountName", '')
  FROM "entry_business_links" l
  JOIN "fund_transactions" ft ON ft."id" = l."fundTransactionId"
  LEFT JOIN "Account" fa ON fa."id" = ft."fundAccountId"
  LEFT JOIN "Account" ca ON ca."id" = ft."cashAccountId"
 WHERE l."cashEntryId" = t."id"
   AND l."deletedAt" IS NULL
   AND t."deletedAt" IS NULL
   AND t."source" = 'regular_invest_refund'
   AND t."toAccountId" IS NULL
   AND ft."fundAccountId" IS NOT NULL
   AND ft."cashAccountId" IS NOT NULL;

-- 2) 买入资金腿：付款方已经是现金账户，补齐收款方基金账户。
UPDATE "transactions" t
   SET "toAccountId"   = ft."fundAccountId",
       "toAccountName" = COALESCE(NULLIF(fa."name", ''), '')
  FROM "entry_business_links" l
  JOIN "fund_transactions" ft ON ft."id" = l."fundTransactionId"
  LEFT JOIN "Account" fa ON fa."id" = ft."fundAccountId"
 WHERE l."cashEntryId" = t."id"
   AND l."deletedAt" IS NULL
   AND t."deletedAt" IS NULL
   AND t."type" = 'investment'
   AND t."toAccountId" IS NULL
   AND t."accountId" IS DISTINCT FROM ft."fundAccountId"
   AND ft."fundAccountId" IS NOT NULL;
