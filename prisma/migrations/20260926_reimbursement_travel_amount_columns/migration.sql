ALTER TABLE "reimbursement_items"
  ADD COLUMN IF NOT EXISTS "outsideTransportAmount" DECIMAL(18,2),
  ADD COLUMN IF NOT EXISTS "cityTransportAmount" DECIMAL(18,2),
  ADD COLUMN IF NOT EXISTS "subsidyAmount" DECIMAL(18,2),
  ADD COLUMN IF NOT EXISTS "lodgingAmount" DECIMAL(18,2);

UPDATE "reimbursement_items"
SET "outsideTransportAmount" = "amount"
WHERE "expenseItem" IN ('transport', 'ticketing', 'toll', 'refundFee', 'insurance');

UPDATE "reimbursement_items"
SET "cityTransportAmount" = "amount"
WHERE "expenseItem" IN ('cityTransport', 'parking');

UPDATE "reimbursement_items"
SET "subsidyAmount" = "amount"
WHERE "expenseItem" IN ('subsidy', 'meal');

UPDATE "reimbursement_items"
SET "lodgingAmount" = "amount"
WHERE "expenseItem" = 'lodging';
