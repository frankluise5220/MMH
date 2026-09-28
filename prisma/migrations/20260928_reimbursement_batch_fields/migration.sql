ALTER TABLE "reimbursement_batches" ADD COLUMN IF NOT EXISTS "note" TEXT;
ALTER TABLE "reimbursement_batches" ADD COLUMN IF NOT EXISTS "startDate" TIMESTAMP(3);
ALTER TABLE "reimbursement_batches" ADD COLUMN IF NOT EXISTS "endDate" TIMESTAMP(3);
