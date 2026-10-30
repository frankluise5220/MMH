-- 账单日 / 还款日变更记录（2026-10-29）：银行改账单日时还款日通常一起改，
-- 所以还款日跟着同一条生效日期的记录走。两种表达各自可空：
-- 固定还款日（1-31）或「账单日后 N 天」（0-62）；都为空表示该时期沿用账户级设置，
-- 因此老数据与未填写的记录行为完全不变。
ALTER TABLE "CreditCardBillingDay" ADD COLUMN "repaymentDay" INTEGER;
ALTER TABLE "CreditCardBillingDay" ADD COLUMN "repaymentOffsetDays" INTEGER;
