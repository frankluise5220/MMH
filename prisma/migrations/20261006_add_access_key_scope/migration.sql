-- Add scope to AccessKey: external API capability, "read" (query only) or
-- "write" (query + bookkeeping). Defaults to "write" so keys created before
-- this column existed keep the full access they already had.
ALTER TABLE "AccessKey" ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'write';
