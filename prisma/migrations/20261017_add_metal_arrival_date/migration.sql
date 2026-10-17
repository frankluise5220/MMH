-- 2026-10-17 金属交易到账日（PreciousMetalTransaction.arrivalDate）
--
-- 与基金 / 理财 / 债券 / 存款一致：金属赎回的钱回到资金账户的日期记在业务行上，
-- 资金账户侧明细用它当「生效日」（排序、日期列、余额），投资账户侧仍显示交易日。
-- 可空：存量金属行没有到账日信息（写入侧此前显式丢弃 TxRecord.fundArrivalDate），
-- 资金侧读取时回退到 date，因此无需回填。
-- 同一份 SQL 同时被 PG（prisma migrate deploy）与 SQLite（build-*-package.cjs 的
-- 内置 MIGRATIONS）使用，所以只用两引擎都支持的 ALTER TABLE ADD COLUMN。
ALTER TABLE "precious_metal_transactions" ADD COLUMN "arrivalDate" TIMESTAMP(3);
