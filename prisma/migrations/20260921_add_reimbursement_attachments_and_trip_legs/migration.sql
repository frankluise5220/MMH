-- Corporate-form parity for reimbursements (2026-09-21).
-- A reimbursement carries a header attachment count and a travel form is filled
-- leg by leg. The misc bucket also gets its own expense items.
ALTER TABLE "reimbursements"
  ADD COLUMN IF NOT EXISTS "attachmentCount" INTEGER;

ALTER TABLE "reimbursement_items"
  ADD COLUMN IF NOT EXISTS "fromPlace" TEXT;

ALTER TABLE "reimbursement_items"
  ADD COLUMN IF NOT EXISTS "toPlace" TEXT;

ALTER TABLE "reimbursement_items"
  ADD COLUMN IF NOT EXISTS "vehicle" TEXT;

DO $$ BEGIN
  CREATE TYPE "ReimbursementExpenseItem" AS ENUM (
    'transport', 'lodging', 'meal', 'cityTransport', 'subsidy', 'other',
    'conference', 'ticketing', 'refundFee', 'insurance', 'parking', 'toll', 'phone'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TYPE "ReimbursementExpenseItem" ADD VALUE IF NOT EXISTS 'conference';
ALTER TYPE "ReimbursementExpenseItem" ADD VALUE IF NOT EXISTS 'ticketing';
ALTER TYPE "ReimbursementExpenseItem" ADD VALUE IF NOT EXISTS 'refundFee';
ALTER TYPE "ReimbursementExpenseItem" ADD VALUE IF NOT EXISTS 'insurance';
ALTER TYPE "ReimbursementExpenseItem" ADD VALUE IF NOT EXISTS 'parking';
ALTER TYPE "ReimbursementExpenseItem" ADD VALUE IF NOT EXISTS 'toll';
ALTER TYPE "ReimbursementExpenseItem" ADD VALUE IF NOT EXISTS 'phone';
