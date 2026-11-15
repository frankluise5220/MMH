-- 期供行落库水位（materializedThroughNo）：计划自己记住「已经落地到第几期」。
--
-- 期供行是「到期才落库」的，原来的判重口径是「这一期是否已经有行」——而用户
-- 允许单期删除，回收站里再「彻底删除」一次，那一行就物理消失，下一次
-- materializeDueInstallmentPayments 便把它当成缺失、又补一条回来（删了又出现）。
-- 有了水位，落库范围只由计划自身推进，与「那一行还在不在」无关。
ALTER TABLE "CreditCardInstallmentPlan"
  ADD COLUMN IF NOT EXISTS "materializedThroughNo" INTEGER NOT NULL DEFAULT 0;

-- 存量计划回填：取已落库的最大期号（含软删行，与 materialize 的历史判重口径一致），
-- 升级后不重发任何历史期；中间被删掉的期也不会被补回来。
-- 已被「彻底删除」的期在这里查不到，只可能复活一次，之后由水位接管。
UPDATE "CreditCardInstallmentPlan" AS p
SET "materializedThroughNo" = COALESCE(
  (
    SELECT MAX(t."installmentNo")
    FROM "transactions" AS t
    WHERE t."creditCardInstallmentPlanId" = p.id
      AND t."installmentRole" IN ('payment', 'fee')
  ),
  0
);

-- 来源记录被「彻底删除」时改为断链（SET NULL），不再级联删掉整条分期计划：
-- 计划里已经落地的是真实支出，不能因为清空回收站里的一条原消费记录就一起消失。
ALTER TABLE "CreditCardInstallmentPlan"
  DROP CONSTRAINT IF EXISTS "CreditCardInstallmentPlan_sourceEntryId_fkey";

ALTER TABLE "CreditCardInstallmentPlan"
  ADD CONSTRAINT "CreditCardInstallmentPlan_sourceEntryId_fkey"
  FOREIGN KEY ("sourceEntryId") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
