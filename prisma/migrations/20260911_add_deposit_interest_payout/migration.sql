ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "depositInterestPayoutFrequency" TEXT;
ALTER TABLE "deposit_transactions" ADD COLUMN IF NOT EXISTS "interestPayoutFrequency" TEXT;
