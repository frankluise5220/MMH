ALTER TABLE "reimbursement_settlements"
  ADD COLUMN IF NOT EXISTS "balanceDiffMode" TEXT NOT NULL DEFAULT 'loss';

UPDATE "reimbursement_settlements"
SET "balanceDiffMode" = CASE WHEN "writeOffAmount" > 0 THEN 'loss' ELSE 'remain' END;

CREATE TABLE IF NOT EXISTS "reimbursement_settlement_transactions" (
  "id" TEXT NOT NULL,
  "settlementId" TEXT NOT NULL,
  "txRecordId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "reimbursement_settlement_transactions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "reimbursement_settlement_transactions_settlementId_fkey"
    FOREIGN KEY ("settlementId") REFERENCES "reimbursement_settlements"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "reimbursement_settlement_transactions_txRecordId_fkey"
    FOREIGN KEY ("txRecordId") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "reimbursement_settlement_transactions_txRecordId_key"
  ON "reimbursement_settlement_transactions"("txRecordId");
CREATE INDEX IF NOT EXISTS "reimbursement_settlement_transactions_settlementId_idx"
  ON "reimbursement_settlement_transactions"("settlementId");

UPDATE "reimbursements" AS r
SET "paymentTxRecordId" = (
  SELECT rst."txRecordId"
  FROM "reimbursement_settlements" rs
  JOIN "reimbursement_settlement_transactions" rst ON rst."settlementId" = rs."id"
  JOIN "transactions" tx ON tx."id" = rst."txRecordId" AND tx."deletedAt" IS NULL
  WHERE rs."reimbursementId" = r."id"
  ORDER BY rs."date" DESC, rs."createdAt" DESC
  LIMIT 1
)
WHERE r."paymentTxRecordId" IS NULL;
