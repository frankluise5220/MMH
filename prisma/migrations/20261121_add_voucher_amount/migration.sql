-- 券 / 包（红包、优惠券）抵扣金额。主交易 amount 记实付，券包另生成一条
-- source=voucher 的 income 分录，voucherSourceEntryId 指回主交易（便于编辑回填）。
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "voucherAmount" DECIMAL(18, 2);
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "voucherSourceEntryId" TEXT;

CREATE INDEX IF NOT EXISTS "transactions_voucherSourceEntryId_idx"
  ON "transactions"("voucherSourceEntryId");
