-- Last successful authentication time per Access Key.
--
-- Nullable and not backfilled: a null value means "unused since this column
-- shipped", which is a truthful answer rather than a guessed one. The write is
-- throttled in access-key-auth.ts to at most once a minute per key.
ALTER TABLE "AccessKey" ADD COLUMN "lastUsedAt" TIMESTAMP(3);
