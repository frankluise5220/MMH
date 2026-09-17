-- Chengtou bond as a wealth product type: product type + bond terms
CREATE TYPE "WealthProductType" AS ENUM ('standard', 'bond');
ALTER TABLE "WealthProduct" ADD COLUMN "productType" "WealthProductType" NOT NULL DEFAULT 'standard';
ALTER TABLE "WealthProduct" ADD COLUMN "maturityDate" TIMESTAMP(3);
ALTER TABLE "WealthProduct" ADD COLUMN "payoutFrequency" TEXT;
ALTER TABLE "WealthProduct" ADD COLUMN "firstPayoutDate" TIMESTAMP(3);
-- write-off action for bond principal that cannot be recovered
ALTER TYPE "FundSubtype" ADD VALUE IF NOT EXISTS 'write_off';
