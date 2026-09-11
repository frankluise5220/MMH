-- 往来款「约定」改挂到**往来款账户**上（原挂 entryId）。
-- 用户定版（09-11）：利率/期限/到期日是「这个往来对象这条关系」的属性，
-- 应该在**建立往来款账户**时提交，而不是挂在某笔交易上。

-- DropForeignKey
ALTER TABLE "DebtAgreement" DROP CONSTRAINT "DebtAgreement_entryId_fkey";

-- DropIndex
DROP INDEX "DebtAgreement_entryId_key";

-- AlterTable
ALTER TABLE "DebtAgreement" DROP COLUMN "entryId",
ADD COLUMN     "accountId" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "DebtAgreement_accountId_key" ON "DebtAgreement"("accountId");

-- AddForeignKey
ALTER TABLE "DebtAgreement" ADD CONSTRAINT "DebtAgreement_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
