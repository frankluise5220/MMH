-- FundConfirmDays.manualOverride：确认日/到账日的「人工锁定」标记。
--
-- 用户在设置页的「基金确认日」表里保存（含新增/修改该账户基金行）后置 true。
-- 此后 days / arrivalDays 只允许这张表再改：投资交易表单、定投表单、批量导入、
-- 初始化导入等自动写入路径一律跳过该行（见 src/lib/fund/confirmDays.ts 的
-- auto 写入函数）。删除该行即解除锁定，自动路径可以重新建行。
--
-- PostgreSQL-compatible（dev / docker 的 prisma migrate deploy 路径）；
-- SQLite 侧由 init-sqlite 依据 schema 生成的 native-init.sql 建列。
ALTER TABLE "FundConfirmDays" ADD COLUMN "manualOverride" BOOLEAN NOT NULL DEFAULT false;
