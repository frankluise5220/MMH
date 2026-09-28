ALTER TABLE "reimbursements"
  ADD COLUMN IF NOT EXISTS "advanceAccountId" TEXT;

CREATE INDEX IF NOT EXISTS "reimbursements_householdId_advanceAccountId_status_idx"
  ON "reimbursements"("householdId", "advanceAccountId", "status");

WITH single_account AS (
  SELECT ri."reimbursementId", MIN(ri."advanceAccountId") AS "advanceAccountId"
  FROM "reimbursement_items" ri
  GROUP BY ri."reimbursementId"
  HAVING COUNT(*) = COUNT(ri."advanceAccountId")
    AND COUNT(DISTINCT ri."advanceAccountId") = 1
)
UPDATE "reimbursements" r
SET "advanceAccountId" = single_account."advanceAccountId"
FROM single_account
WHERE r."id" = single_account."reimbursementId"
  AND r."advanceAccountId" IS NULL;
