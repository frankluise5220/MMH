-- 电子钱包 → 货币基金的支付关联（2026-11-18）
-- 钱包账户可以指定一个货基账户 + 具体基金代码；在支出弹窗里勾选「从关联货基支付」时，
-- 服务端会生成一笔货基赎回（份额减、资金腿回钱包）并与该笔支出绑定。
-- 两列均可空：未绑定的钱包行为完全不变。
ALTER TABLE "Account"
  ADD COLUMN IF NOT EXISTS "linkedFundAccountId" TEXT;

ALTER TABLE "Account"
  ADD COLUMN IF NOT EXISTS "linkedFundCode" TEXT;

CREATE INDEX IF NOT EXISTS "Account_linkedFundAccountId_idx" ON "Account"("linkedFundAccountId");
