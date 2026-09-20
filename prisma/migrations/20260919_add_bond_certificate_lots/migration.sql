-- 债券存单粒度：买入行即一张「存单」（一个持仓），同一债单可有多张存单；
-- 付息/赎回/核销等子行用 sourceBondTransactionId 指回所属存单。
-- 条款（期限/到期日/付息方式/首次付息日/计息基础）作为存单快照落在存单行上，
-- 缺省时回退债单主数据 BondProduct 的同名字段。
ALTER TABLE "bond_transactions" ADD COLUMN "sourceBondTransactionId" TEXT;
ALTER TABLE "bond_transactions" ADD COLUMN "termDays" INTEGER;
ALTER TABLE "bond_transactions" ADD COLUMN "maturityDate" TIMESTAMP(3);
ALTER TABLE "bond_transactions" ADD COLUMN "payoutFrequency" TEXT;
ALTER TABLE "bond_transactions" ADD COLUMN "firstPayoutDate" TIMESTAMP(3);
ALTER TABLE "bond_transactions" ADD COLUMN "interestCalcBasis" TEXT;

CREATE INDEX "bond_transactions_sourceBondTransactionId_idx" ON "bond_transactions"("sourceBondTransactionId");

ALTER TABLE "bond_transactions"
  ADD CONSTRAINT "bond_transactions_sourceBondTransactionId_fkey"
  FOREIGN KEY ("sourceBondTransactionId") REFERENCES "bond_transactions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
