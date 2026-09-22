-- A counterparty can be flagged as reimbursable (2026-09-21).
-- Only counterparties flagged as reimbursable expose the reimbursement entry
-- points (debt-view row toolbar + detail-list selection). The flag is opt-in,
-- so existing rows keep their current behaviour until explicitly enabled.
ALTER TABLE "Counterparty"
  ADD COLUMN IF NOT EXISTS "isReimbursable" BOOLEAN NOT NULL DEFAULT false;
