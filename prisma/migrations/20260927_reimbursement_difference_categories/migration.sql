ALTER TABLE "transactions"
  ADD COLUMN IF NOT EXISTS "reimbursementDifferenceAmount" DECIMAL(18,2);

ALTER TABLE "transactions"
  ADD COLUMN IF NOT EXISTS "reimbursementDifferenceCategoryName" TEXT;
