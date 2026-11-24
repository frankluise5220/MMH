-- 每期本金自定义排期（用户逐期调整分期金额）。
-- JSON number[]，长度 = totalRuns，合计 = installmentPrincipal；NULL = 等额分摊。
-- IF NOT EXISTS：开发库已用脚本补过该列（2026-11-24 本地手工 ALTER），
-- 再跑 migrate deploy 不应因「column already exists」整批失败。
ALTER TABLE "CreditCardInstallmentPlan" ADD COLUMN IF NOT EXISTS "principalScheduleJson" TEXT;
