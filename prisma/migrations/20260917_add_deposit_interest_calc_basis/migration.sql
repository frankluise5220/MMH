-- Deposit interest calculation basis: daily proration (default) or equal monthly division
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "depositInterestCalcBasis" TEXT;
ALTER TABLE "deposit_transactions" ADD COLUMN IF NOT EXISTS "interestCalcBasis" TEXT;
