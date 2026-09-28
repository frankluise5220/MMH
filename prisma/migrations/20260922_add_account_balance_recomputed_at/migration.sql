-- Incremental balance maintenance (2026-09-22).
--
-- Account.balance is now maintained as an incremental cache anchored on the
-- account's last balance-reconcile row instead of a full history fold on every
-- record change. balanceRecomputedAt records the as-of day of the cached value
-- so the maintenance path knows how far it must catch up.
--
-- Existing rows stay NULL until the background maintenance path adopts the
-- already-persisted Account.balance as the baseline and records the current
-- as-of day. A full rebuild remains available through the explicit
-- recalculate/reconcile actions.
ALTER TABLE "Account"
  ADD COLUMN IF NOT EXISTS "balanceRecomputedAt" TIMESTAMP(3);
