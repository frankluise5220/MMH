ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "depositMaturityAction" TEXT;
ALTER TABLE "deposit_transactions" ADD COLUMN IF NOT EXISTS "maturityAction" TEXT;
