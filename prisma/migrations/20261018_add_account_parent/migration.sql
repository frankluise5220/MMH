-- Account.parentId / isAggregate：多币种父账户（聚合账户）层级。
--
-- 产品口径（2026-10-18 用户裁定）：
--   * 父账户 = 统计单元（参与资产/净值/报表汇总），自身没有明细，也不能直接记账；
--   * 子账户 = 记账单元，按币种拆分，明细只挂在子账户上；
--   * 父账户余额由子户按账簿本位币折算维护，不来自任何流水。
--
-- 这是**纯增量**变更：存量行 parentId = NULL、isAggregate = false，行为与升级前
-- 完全一致。升级动作在运行时由用户触发（新建父行 + 原账户 parentId 指向它），
-- 不需要回填脚本，也不迁移任何流水。
ALTER TABLE "Account" ADD COLUMN "parentId" TEXT;
ALTER TABLE "Account" ADD COLUMN "isAggregate" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "Account_parentId_idx" ON "Account"("parentId");
-- 同一父账户下每个币种只能有一个子户；PG 允许多个 NULL，根账户之间不会冲突。
CREATE UNIQUE INDEX "Account_parentId_currency_key" ON "Account"("parentId", "currency");

ALTER TABLE "Account" ADD CONSTRAINT "Account_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
