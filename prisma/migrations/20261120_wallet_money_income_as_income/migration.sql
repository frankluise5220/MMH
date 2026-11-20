-- 电子钱包绑货基的每日收益（source=money_fund_income）是收入，不是基金申赎。
-- type=investment 会让明细把它当「基金赎回」编辑：弹基金交易窗、还要求选一个
-- 轻量模型里根本不存在的货币基金账户（2026-11-20 用户裁定）。
-- source 仍保留：它是「同一天只结一条」的唯一索引键，也是报表已实现收益的口径标记，
-- 与 type 无关，改 type 不会让补结重复。
-- 旧口径（钱包绑货基账户）的镜像行带 fundSubtype=buy 也一起改：它们同样在钱包账户上、
-- 同样是每日收益，只是统计侧一直被 source 排除（报表统一走 loadWalletMoneyFundIncomeEntries
-- 的 fundSubtype IS NULL 那批），改 type 不会让它们重新被算一次。
UPDATE "transactions"
SET "type" = 'income'
WHERE "source" = 'money_fund_income'
  AND "type" = 'investment';
