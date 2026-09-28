ALTER TABLE "reimbursement_settlements"
  ADD COLUMN IF NOT EXISTS "feeAmount" DECIMAL(18,2) NOT NULL DEFAULT 0;
