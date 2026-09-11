ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "originalCurrency" TEXT;
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "originalAmount" DECIMAL(18, 2);
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "locationId" TEXT;
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "locationName" TEXT;
