import {
  CreditCardInstallmentSourceType,
  TransactionType,
  type Prisma,
} from "@prisma/client";

import {
  buildCreditCardInstallmentSchedule,
  type CreditCardInstallmentRateType,
} from "@/lib/credit/installment";
import { attachEntryTags } from "@/lib/server/entry-tags";

type InstallmentWriter = Prisma.TransactionClient;

export type CreateCreditCardInstallmentInput = {
  householdId: string;
  account: { id: string; name: string };
  sourceType: CreditCardInstallmentSourceType;
  sourceEntryId?: string | null;
  sourceStatementMonth?: string | null;
  originalAmount: number;
  principal: number;
  totalRuns: number;
  rateType: CreditCardInstallmentRateType;
  rate: number;
  adjustmentDate: Date;
  adjustmentStatementMonth: string;
  firstPaymentDate: Date;
  firstPaymentStatementMonth: string;
  category?: { id: string; name: string } | null;
  label: string;
  tagIds?: string[];
};

export async function createCreditCardInstallmentPlan(
  tx: InstallmentWriter,
  input: CreateCreditCardInstallmentInput,
) {
  if (input.sourceType === CreditCardInstallmentSourceType.transaction && !input.sourceEntryId) {
    throw new Error("消费分期缺少原消费记录");
  }
  if (input.sourceType === CreditCardInstallmentSourceType.statement && !input.sourceStatementMonth) {
    throw new Error("账单分期缺少来源账单月份");
  }
  if (!Number.isFinite(input.originalAmount) || input.originalAmount <= 0) {
    throw new Error("原金额必须大于 0");
  }
  if (!Number.isFinite(input.principal) || input.principal <= 0 || input.principal > input.originalAmount) {
    throw new Error("分期金额必须大于 0，且不能超过可分期金额");
  }

  const schedule = buildCreditCardInstallmentSchedule({
    principal: input.principal,
    totalRuns: input.totalRuns,
    rateType: input.rateType,
    rate: input.rate,
    firstStatementMonth: input.firstPaymentStatementMonth,
    firstDate: input.firstPaymentDate,
  });
  const plan = await tx.creditCardInstallmentPlan.create({
    data: {
      householdId: input.householdId,
      accountId: input.account.id,
      sourceType: input.sourceType,
      sourceEntryId: input.sourceEntryId ?? null,
      sourceStatementMonth: input.sourceStatementMonth ?? null,
      originalAmount: input.originalAmount,
      installmentPrincipal: input.principal,
      totalRuns: input.totalRuns,
      rateType: input.rateType,
      rate: input.rate,
      firstStatementMonth: input.firstPaymentStatementMonth,
    },
  });

  await tx.txRecord.create({
    data: {
      householdId: input.householdId,
      accountId: input.account.id,
      accountName: input.account.name,
      categoryId: input.category?.id ?? null,
      categoryName: input.category?.name ?? null,
      amount: input.principal,
      type: TransactionType.expense,
      date: input.adjustmentDate,
      postedAt: input.adjustmentDate,
      statementMonth: input.adjustmentStatementMonth,
      source: "credit_card_installment",
      creditCardInstallmentPlanId: plan.id,
      installmentTotal: input.totalRuns,
      installmentPrincipal: input.principal,
      installmentInterest: 0,
      installmentRole: "adjustment",
      note: `${input.sourceType === CreditCardInstallmentSourceType.statement ? "账单分期" : "消费分期"}冲抵：${input.label}`,
    },
  });

  for (const row of schedule) {
    const entry = await tx.txRecord.create({
      data: {
        householdId: input.householdId,
        accountId: input.account.id,
        accountName: input.account.name,
        categoryId: input.category?.id ?? null,
        categoryName: input.category?.name ?? null,
        amount: -row.payment,
        type: TransactionType.expense,
        date: row.date,
        postedAt: row.date,
        statementMonth: row.statementMonth,
        source: "credit_card_installment",
        creditCardInstallmentPlanId: plan.id,
        installmentNo: row.installmentNo,
        installmentTotal: input.totalRuns,
        installmentPrincipal: row.principal,
        installmentInterest: row.interest,
        installmentRole: "payment",
        note: `${input.label}（${input.sourceType === CreditCardInstallmentSourceType.statement ? "账单" : "消费"}分期 ${row.installmentNo}/${input.totalRuns}）`,
      },
    });
    if (input.tagIds?.length) {
      await attachEntryTags({
        tx,
        entryId: entry.id,
        householdId: input.householdId,
        tagIds: input.tagIds,
      });
    }
  }

  return { plan, schedule };
}
