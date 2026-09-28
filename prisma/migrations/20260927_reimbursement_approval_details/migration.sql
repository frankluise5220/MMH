ALTER TABLE "reimbursements" ADD COLUMN IF NOT EXISTS "approvalDate" TIMESTAMP(3);
ALTER TABLE "reimbursements" ADD COLUMN IF NOT EXISTS "approvalNote" TEXT;
