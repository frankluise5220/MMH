-- Split loan/debt counterparties from financial institutions.
CREATE TABLE "Counterparty" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shortName" TEXT,
    "type" TEXT,
    "householdId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Counterparty_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Account" ADD COLUMN "counterpartyId" TEXT;

CREATE INDEX "Account_counterpartyId_idx" ON "Account"("counterpartyId");
CREATE INDEX "Counterparty_householdId_name_idx" ON "Counterparty"("householdId", "name");

ALTER TABLE "Account" ADD CONSTRAINT "Account_counterpartyId_fkey"
    FOREIGN KEY ("counterpartyId") REFERENCES "Counterparty"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Counterparty" ADD CONSTRAINT "Counterparty_householdId_fkey"
    FOREIGN KEY ("householdId") REFERENCES "Household"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Compatibility backfill: keep old Institution rows in place, but copy legacy
-- debt/person/organization/family-member records into the new counterparty table.
INSERT INTO "Counterparty" ("id", "name", "shortName", "type", "householdId")
SELECT
    "id",
    "name",
    "shortName",
    CASE
      WHEN "type" = 'debt' THEN 'organization'
      WHEN "type" IN ('family_member', 'person', 'organization', 'other') THEN "type"
      ELSE 'other'
    END,
    "householdId"
FROM "Institution"
WHERE "type" IN ('debt', 'family_member', 'person', 'organization', 'other')
ON CONFLICT ("id") DO NOTHING;

UPDATE "Account"
SET "counterpartyId" = "institutionId"
WHERE "kind" = 'loan'
  AND "institutionId" IN (SELECT "id" FROM "Counterparty");
