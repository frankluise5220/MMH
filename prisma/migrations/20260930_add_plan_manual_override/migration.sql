-- Add manualOverride to RegularInvestPlan: user-manual override flag for
-- deposit system plans (depm_/depi_). When true, the plan row's interval /
-- amount / nextRunDate are authoritative and no longer re-derived from the
-- deposit lot's terms.
-- PostgreSQL-compatible (the dev / docker migrate-deploy path).
ALTER TABLE "RegularInvestPlan" ADD COLUMN "manualOverride" BOOLEAN NOT NULL DEFAULT false;
