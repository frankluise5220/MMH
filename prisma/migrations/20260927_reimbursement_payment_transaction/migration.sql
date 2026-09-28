ALTER TABLE "reimbursements"
  ADD COLUMN IF NOT EXISTS "paymentTxRecordId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "reimbursements_paymentTxRecordId_key"
  ON "reimbursements"("paymentTxRecordId");

ALTER TABLE "reimbursements"
  ADD CONSTRAINT "reimbursements_paymentTxRecordId_fkey"
  FOREIGN KEY ("paymentTxRecordId") REFERENCES "transactions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
