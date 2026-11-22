-- 附属卡（2026-11-22 用户裁定）：账单模式新增 supplementary，账户上新增
-- 「所有人」（用户自定义填写的附属卡持卡人）与「主卡」自关联。
-- 存量账户不回填：creditBillMode 默认 separate，两列均为空。

ALTER TYPE "CreditBillMode" ADD VALUE 'supplementary';

ALTER TABLE "Account"
ADD COLUMN "cardHolderName" TEXT,
ADD COLUMN "primaryCardId" TEXT;

CREATE INDEX "Account_householdId_primaryCardId_idx"
ON "Account"("householdId", "primaryCardId");

ALTER TABLE "Account"
ADD CONSTRAINT "Account_primaryCardId_fkey"
FOREIGN KEY ("primaryCardId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
