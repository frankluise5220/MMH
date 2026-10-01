-- 存款/债券到期日口径更正（2026-10-01 用户裁定）。
--
-- 旧实现 `depositTermMaturityUtc` 把「算头不算尾」错用到**到期日**上：
--   2026-12-21 存 1 年 → 到期日 2027-12-20（应为其对年对月对日 2027-12-21），
-- 再靠 `depositInterestDaysUtc` 的 +1 补偿把利息修回 365 天 —— 结果是**利息对、
-- 到期日早一天**，且与已定版的付息锚点口径（`depositPayoutAnchorUtc`：对应日、
-- 不提前一天，2026-09-29 定版）自相矛盾。银行业惯例是「对年、对月、对日计算，
-- 自存入日至次年同月同日为一对年」；「算头不算尾」只约束计息天数。
--
-- 本迁移把「到期日 + 1 天 == 起存日 + N 整年（N ≥ 1，闰日按月末钳制）」的行推回周年。
-- 幂等：迁移后到期日 == 周年，条件不再匹配，重复执行是 no-op。
-- 判定与 JS 侧 `addCalendarYearsUtc` 等价（N 由跨度天数 /365 四舍五入得到，
-- 因此 2025-01-01 → 2025-12-31 这种跨年但同年份的 364 天跨度也能命中）。
--
-- 配套改动：`src/lib/deposit-term.ts` 的 `depositTermMaturityUtc`、
-- `src/lib/date-utils.ts` 的 `addDepositTermUtc` 已改为不加 −1 天；
-- `splitTermDays` / `depositInterestDaysUtc` **保留**对「周年 − 1 天」旧数据的识别，
-- 所以未迁移的库仍能正确反解出整年、并按 365/366 天计息。
--
-- PostgreSQL-compatible（dev / docker migrate-deploy 路径）。
-- SQLite 侧由 `scripts/build-fnos-package.cjs` 的 MIGRATIONS 条目
-- `20261001_deposit_maturity_anniversary` 等价实现（那边按原存储格式读写，
-- 不走 SQL 日期函数，因为 Prisma 用 iso8601 字符串存 DateTime）。

-- 存款存单（TxRecord → transactions）
UPDATE "transactions"
   SET "fundArrivalDate" = "fundArrivalDate" + INTERVAL '1 day'
 WHERE "type" = 'investment'
   AND "fundProductType" = 'deposit'
   AND "fundSubtype" = 'buy'
   AND "deletedAt" IS NULL
   AND "fundArrivalDate" IS NOT NULL
   AND "date" IS NOT NULL
   AND ROUND(("fundArrivalDate"::date - "date"::date) / 365.0) >= 1
   AND ("fundArrivalDate"::date + INTERVAL '1 day')::date
       = ("date"::date + (ROUND(("fundArrivalDate"::date - "date"::date) / 365.0)::int * INTERVAL '1 year'))::date;

-- 债券买入行（BondTransaction → bond_transactions）：同口径，起存日取 tradeDate
UPDATE "bond_transactions"
   SET "maturityDate" = "maturityDate" + INTERVAL '1 day'
 WHERE "action" = 'buy'
   AND "deletedAt" IS NULL
   AND "maturityDate" IS NOT NULL
   AND "tradeDate" IS NOT NULL
   AND ROUND(("maturityDate"::date - "tradeDate"::date) / 365.0) >= 1
   AND ("maturityDate"::date + INTERVAL '1 day')::date
       = ("tradeDate"::date + (ROUND(("maturityDate"::date - "tradeDate"::date) / 365.0)::int * INTERVAL '1 year'))::date;
