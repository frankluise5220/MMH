-- Add reimbursement module tables: reimbursement forms generated from advance (dai-fu) records.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ReimbursementStatus') THEN
        CREATE TYPE "ReimbursementStatus" AS ENUM ('pending', 'reimbursed');
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS "reimbursements" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "counterpartyId" TEXT NOT NULL,
    "counterpartyName" TEXT NOT NULL,
    "status" "ReimbursementStatus" NOT NULL DEFAULT 'pending',
    "totalAmount" DECIMAL(18,2) NOT NULL,
    "reimbursedDate" TIMESTAMP(3),
    "cashAccountId" TEXT,
    "cashAccountName" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "reimbursements_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "reimbursement_items" (
    "id" TEXT NOT NULL,
    "reimbursementId" TEXT NOT NULL,
    "txRecordId" TEXT NOT NULL,
    "advanceAccountId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "entryDate" TIMESTAMP(3) NOT NULL,
    "categoryName" TEXT,
    "note" TEXT,
    "invoiceCode" TEXT,
    "invoiceNumber" TEXT,
    "invoiceAmount" DECIMAL(18,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "reimbursement_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "reimbursement_items_txRecordId_key"
    ON "reimbursement_items"("txRecordId");
CREATE INDEX IF NOT EXISTS "reimbursements_householdId_status_idx"
    ON "reimbursements"("householdId", "status");
CREATE INDEX IF NOT EXISTS "reimbursements_householdId_counterpartyId_status_idx"
    ON "reimbursements"("householdId", "counterpartyId", "status");
CREATE INDEX IF NOT EXISTS "reimbursement_items_reimbursementId_idx"
    ON "reimbursement_items"("reimbursementId");
CREATE INDEX IF NOT EXISTS "reimbursement_items_advanceAccountId_idx"
    ON "reimbursement_items"("advanceAccountId");

ALTER TABLE "reimbursements" ADD CONSTRAINT "reimbursements_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reimbursement_items" ADD CONSTRAINT "reimbursement_items_reimbursementId_fkey" FOREIGN KEY ("reimbursementId") REFERENCES "reimbursements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
