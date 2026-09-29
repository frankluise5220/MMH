-- Add fnosUid to User: fnOS user UID / FN ID bound to a ledger user.
-- Model 1: the same UID may be bound in multiple ledgers, but is unique within a ledger.
-- PostgreSQL-compatible (the dev / docker migrate-deploy path).
ALTER TABLE "User" ADD COLUMN "fnosUid" TEXT;
CREATE UNIQUE INDEX "User_householdId_fnosUid_key" ON "User"("householdId", "fnosUid");
