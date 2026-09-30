-- Add explicit plan-group and action metadata for deposit/bond lifecycle plans.
ALTER TABLE "RegularInvestPlan" ADD COLUMN "planGroupId" TEXT;
ALTER TABLE "RegularInvestPlan" ADD COLUMN "planAction" TEXT;
CREATE INDEX "RegularInvestPlan_planGroupId_idx" ON "RegularInvestPlan"("planGroupId");
CREATE INDEX "RegularInvestPlan_planAction_idx" ON "RegularInvestPlan"("planAction");
