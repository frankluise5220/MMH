-- Sponsor tip intent ledger (2026-09-22).
-- Static Alipay QR codes cannot confirm settlement automatically. This table
-- records the signed-in user, active household, contact email, selected amount,
-- and whether the user later self-reported that the payment was completed.
CREATE TABLE "SponsorTipIntent" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "householdId" TEXT,
  "email" TEXT NOT NULL,
  "amount" DECIMAL(10, 2) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "claimedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SponsorTipIntent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SponsorTipIntent_userId_createdAt_idx"
  ON "SponsorTipIntent"("userId", "createdAt");

CREATE INDEX "SponsorTipIntent_householdId_createdAt_idx"
  ON "SponsorTipIntent"("householdId", "createdAt");

CREATE INDEX "SponsorTipIntent_email_idx"
  ON "SponsorTipIntent"("email");

ALTER TABLE "SponsorTipIntent"
  ADD CONSTRAINT "SponsorTipIntent_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SponsorTipIntent"
  ADD CONSTRAINT "SponsorTipIntent_householdId_fkey"
  FOREIGN KEY ("householdId") REFERENCES "Household"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
