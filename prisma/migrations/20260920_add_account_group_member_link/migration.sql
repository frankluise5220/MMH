-- Owner group <-> family member data-layer link: AccountGroup.institutionId.
-- Family members (Institution.type='family_member') own their accounts through
-- the owner group; the FK replaces the previous name-matching convention.
ALTER TABLE "AccountGroup" ADD COLUMN IF NOT EXISTS "institutionId" TEXT;
CREATE INDEX IF NOT EXISTS "AccountGroup_institutionId_idx" ON "AccountGroup"("institutionId");
ALTER TABLE "AccountGroup"
  ADD CONSTRAINT "AccountGroup_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "Institution"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
