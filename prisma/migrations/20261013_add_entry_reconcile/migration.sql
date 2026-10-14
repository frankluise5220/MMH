-- 2026-10-13 流水「对账」锁定（TxRecord.reconciledAt / reconciledBalance）
--
-- 明细列表里对选中的记录「对账」后，该记录被锁定：
--   1) 不可删除、不可修改（编辑窗只读），只有解除对账（点锁标记）后才能再改；
--   2) reconciledBalance 钉住「对账当时这一行的事后余额」，余额折叠把它当锚点用
--      （等价于现有的「余额校准」），因此它之前流水的变化不会再影响它及之后的行。
--
-- 两列都可空：存量流水全部是「未对账」。
-- 同一份 SQL 同时被 PG（prisma migrate deploy）与 SQLite（build-*-package.cjs 的
-- 内置 MIGRATIONS）使用，所以只用两引擎都支持的 ALTER TABLE ADD COLUMN。
ALTER TABLE "transactions" ADD COLUMN "reconciledAt" TIMESTAMP(3);
ALTER TABLE "transactions" ADD COLUMN "reconciledBalance" DECIMAL(18,2);
