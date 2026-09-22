-- Reimbursement templates distinguish advance payments from travel expenses.
-- Travel forms carry trip dates, a reason, and per-item expense categories.
-- Item rows may be hand-added (for example, a travel subsidy), so txRecordId /
-- advanceAccountId become nullable.
DO $$ BEGIN
  CREATE TYPE "ReimbursementKind" AS ENUM ('advance', 'travel');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ReimbursementExpenseItem" AS ENUM ('transport', 'lodging', 'meal', 'cityTransport', 'subsidy', 'other');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "reimbursements"
  ADD COLUMN IF NOT EXISTS "kind" "ReimbursementKind" NOT NULL DEFAULT 'advance';

ALTER TABLE "reimbursements"
  ADD COLUMN IF NOT EXISTS "travelStartDate" TIMESTAMP(3);

ALTER TABLE "reimbursements"
  ADD COLUMN IF NOT EXISTS "travelEndDate" TIMESTAMP(3);

ALTER TABLE "reimbursements"
  ADD COLUMN IF NOT EXISTS "travelReason" TEXT;

ALTER TABLE "reimbursement_items"
  ADD COLUMN IF NOT EXISTS "expenseItem" "ReimbursementExpenseItem";

ALTER TABLE "reimbursement_items"
  ALTER COLUMN "txRecordId" DROP NOT NULL;

ALTER TABLE "reimbursement_items"
  ALTER COLUMN "advanceAccountId" DROP NOT NULL;
