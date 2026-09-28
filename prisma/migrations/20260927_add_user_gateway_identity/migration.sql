ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "gatewayUserId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "User_householdId_gatewayUserId_key"
  ON "User"("householdId", "gatewayUserId");
