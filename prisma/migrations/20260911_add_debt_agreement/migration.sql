-- 往来款「约定」表：利率 / 时长 / 到期日，1:1 关联 transactions（TxRecord）。
-- 每笔记录只记实际发生的本金与利息（TxRecord.debtPrincipalAmount / debtInterestAmount），
-- 约定本身挂在那笔「借出/借入」的往来记录上。
CREATE TABLE "DebtAgreement" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "annualRate" DECIMAL(10,6),
    "termValue" INTEGER,
    "termUnit" "IntervalUnit",
    "dueDate" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DebtAgreement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DebtAgreement_entryId_key" ON "DebtAgreement"("entryId");

CREATE INDEX "DebtAgreement_householdId_dueDate_idx" ON "DebtAgreement"("householdId", "dueDate");

ALTER TABLE "DebtAgreement" ADD CONSTRAINT "DebtAgreement_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DebtAgreement" ADD CONSTRAINT "DebtAgreement_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
