CREATE TABLE IF NOT EXISTS "reimbursement_batches" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "advanceAccountId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "reimbursement_batches_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "reimbursement_batches_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "reimbursement_batches_householdId_advanceAccountId_createdAt_idx"
  ON "reimbursement_batches"("householdId", "advanceAccountId", "createdAt");

ALTER TABLE "reimbursements" ADD COLUMN IF NOT EXISTS "batchId" TEXT;

INSERT INTO "reimbursement_batches" ("id", "householdId", "advanceAccountId", "title", "createdAt", "updatedAt")
SELECT 'rb_' || r."id", r."householdId", COALESCE(r."advanceAccountId", ''), r."title", r."createdAt", r."updatedAt"
FROM "reimbursements" r
WHERE r."batchId" IS NULL
ON CONFLICT ("id") DO NOTHING;

UPDATE "reimbursements" SET "batchId" = 'rb_' || "id" WHERE "batchId" IS NULL;

CREATE INDEX IF NOT EXISTS "reimbursements_batchId_idx" ON "reimbursements"("batchId");
DO $$ BEGIN
  ALTER TABLE "reimbursements" ADD CONSTRAINT "reimbursements_batchId_fkey"
    FOREIGN KEY ("batchId") REFERENCES "reimbursement_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "reimbursement_transactions" (
  "id" TEXT NOT NULL,
  "reimbursementId" TEXT NOT NULL,
  "txRecordId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "reimbursement_transactions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "reimbursement_transactions_reimbursementId_fkey" FOREIGN KEY ("reimbursementId") REFERENCES "reimbursements"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "reimbursement_transactions_txRecordId_key" ON "reimbursement_transactions"("txRecordId");
CREATE INDEX IF NOT EXISTS "reimbursement_transactions_reimbursementId_idx" ON "reimbursement_transactions"("reimbursementId");

INSERT INTO "reimbursement_transactions" ("id", "reimbursementId", "txRecordId")
SELECT 'rt_' || ri."id", ri."reimbursementId", ri."txRecordId"
FROM "reimbursement_items" ri
WHERE ri."txRecordId" IS NOT NULL
ON CONFLICT ("txRecordId") DO NOTHING;

CREATE TABLE IF NOT EXISTS "reimbursement_settlements" (
  "id" TEXT NOT NULL,
  "reimbursementId" TEXT NOT NULL,
  "amount" DECIMAL(18,2) NOT NULL,
  "writeOffAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "date" TIMESTAMP(3) NOT NULL,
  "cashAccountId" TEXT NOT NULL,
  "cashAccountName" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "reimbursement_settlements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "reimbursement_settlements_reimbursementId_fkey" FOREIGN KEY ("reimbursementId") REFERENCES "reimbursements"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "reimbursement_settlements_reimbursementId_date_idx"
  ON "reimbursement_settlements"("reimbursementId", "date");
