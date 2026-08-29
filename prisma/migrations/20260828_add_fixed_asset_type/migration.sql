-- Generalize property assets into multi-type fixed assets.
-- Add assetType (enum) and attributes (JSON) to property_assets.
ALTER TABLE "property_assets" ADD COLUMN "assetType" TEXT NOT NULL DEFAULT 'property';
ALTER TABLE "property_assets" ADD COLUMN "attributes" JSONB;

-- Add fixedAssetType to Account so a fixed asset account can declare its
-- default asset type (property, vehicle, equipment, furniture, collectible, other).
ALTER TABLE "Account" ADD COLUMN "fixedAssetType" TEXT;