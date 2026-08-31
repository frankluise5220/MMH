"use server";

import { AccountKind, IntervalUnit, RegularInvestStatus, TransactionType } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { isPureInvestmentAccount } from "@/lib/account-kind-utils";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { invalidateCreditCardCycleCacheForAccountIds } from "@/lib/server/credit-card-cycle-cache";
import { ensureSettlementTransferCategory } from "@/lib/default-categories";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { replaceLoanRateAdjustmentsForAccount } from "@/lib/server/loan-rate-adjustments";
import { revalidateAfterTxChange } from "@/lib/server/revalidate";
import { executeNonFundScheduledTaskPlan } from "@/lib/server/scheduled-task-executor";
import { encodeLoanPrepayStrategy, normalizeLoanPrepayStrategy } from "@/lib/loan-prepay-strategy";
import { calcLoanScheduledAmount, isInstallmentRepaymentMethod, normalizeLoanRateAdjustments, normalizeLoanRepaymentMethod, INSTALLMENT_REPAYMENT_METHOD } from "@/lib/loan-repayment";
import { buildMortgageLprRateAdjustments, MORTGAGE_BASE_BENCHMARK_RATE } from "@/lib/loan-lpr";
import { decodeScheduledTaskMemo, encodeScheduledTaskMemo } from "@/lib/scheduled-task";
import { calcInitialScheduledRunDate } from "@/lib/scheduled-task-date";
import { formatDateUtc, toNumber, toStatementMonth } from "@/lib/date-utils";

function parseMoneyInput(value: FormDataEntryValue | null) {
  const parsed = parseFloat(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

async function resolveOrCreateDebtAccount(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  householdId: string,
  debtObjectId: string,
  direction: "payable" | "receivable",
  itemName?: string,
) {
  const debtObject = await resolveDebtObject(tx, householdId, debtObjectId);

  const objectName = debtObject.shortName?.trim() || debtObject.name;
  const accountName = debtObject.kind === "counterparty"
    ? `${objectName}的往来款`
    : itemName?.trim() || `${objectName}的往来款`;
  const objectWhere = debtObject.kind === "counterparty"
    ? { counterpartyId: debtObject.id, institutionId: null }
    : { institutionId: debtObject.id, counterpartyId: null };
  const requestedItemName = debtObject.kind === "counterparty" ? "" : itemName?.trim();
  let existing;
  if (debtObject.kind === "counterparty") {
    existing = await tx.account.findFirst({
      where: {
        householdId,
        ...objectWhere,
        kind: AccountKind.loan,
        ...(requestedItemName ? { name: accountName } : {}),
        isPlaceholder: { not: true },
      },
      include: { Institution: { select: { id: true, name: true, type: true } }, Counterparty: { select: { id: true, name: true, type: true } } },
      orderBy: [{ isActive: "desc" }, { createdAt: "asc" }],
    });
  } else {
    existing =
      (await tx.account.findFirst({
        where: {
          householdId,
          ...objectWhere,
          kind: AccountKind.loan,
          debtDirection: direction,
          isPlaceholder: { not: true },
        },
        include: { Institution: { select: { id: true, name: true, type: true } }, Counterparty: { select: { id: true, name: true, type: true } } },
        orderBy: [{ isActive: "desc" }, { createdAt: "asc" }],
      })) ??
      (await tx.account.findFirst({
        where: {
          householdId,
          ...objectWhere,
          kind: AccountKind.loan,
          debtDirection: null,
          isPlaceholder: { not: true },
        },
        include: { Institution: { select: { id: true, name: true, type: true } }, Counterparty: { select: { id: true, name: true, type: true } } },
        orderBy: [{ isActive: "desc" }, { createdAt: "asc" }],
      }));
  }
  if (existing) {
    if (!existing.isActive || (debtObject.kind !== "counterparty" && existing.debtDirection !== direction)) {
      return tx.account.update({
        where: { id: existing.id },
        data: {
          isActive: true,
          ...(debtObject.kind !== "counterparty" ? { debtDirection: direction } : {}),
        },
        include: { Institution: { select: { id: true, name: true, type: true } }, Counterparty: { select: { id: true, name: true, type: true } } },
      });
    }
    return existing;
  }

  const group =
    (await tx.accountGroup.findFirst({ where: { householdId, name: { in: ["往来款", "借入/借出", "负债"] } }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] })) ??
    (await tx.accountGroup.findFirst({ where: { householdId }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }));
  if (!group) throw new Error("缺少账户分组，无法创建往来款账户");

  return tx.account.create({
    data: {
      name: accountName,
      kind: AccountKind.loan,
      debtDirection: debtObject.kind === "counterparty" ? "receivable" : direction,
      currency: "CNY",
      groupId: group.id,
      institutionId: debtObject.kind === "institution" ? debtObject.id : null,
      counterpartyId: debtObject.kind === "counterparty" ? debtObject.id : null,
      householdId,
      isActive: true,
    },
    include: { Institution: { select: { id: true, name: true, type: true } }, Counterparty: { select: { id: true, name: true, type: true } } },
  });
}

async function resolveDebtObject(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  householdId: string,
  debtObjectId: string,
) {
  const refMatch = /^(counterparty|institution):(.+)$/.exec(debtObjectId);
  const sourceKind = refMatch?.[1] ?? "counterparty";
  const sourceId = refMatch?.[2] ?? debtObjectId;
  if (sourceKind === "institution") {
    const institution = await tx.institution.findFirst({
      where: { id: sourceId, householdId, type: { in: ["bank", "debt"] } },
      select: { id: true, name: true, shortName: true, type: true },
    });
    if (!institution) throw new Error("贷款机构只能选择银行或贷款机构");
    return { ...institution, kind: "institution" as const };
  }

  const counterparty = await tx.counterparty.findFirst({
    where: { id: sourceId, householdId },
    select: { id: true, name: true, shortName: true, type: true },
  });
  if (!counterparty) throw new Error("请选择往来对象");
  return { ...counterparty, kind: "counterparty" as const };
}


function parseDateOnlyUtc(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

const FIXED_LOAN_REPAYMENT_METHODS = new Set(["等额本息", "等额本金", INSTALLMENT_REPAYMENT_METHOD, "先还利息一次性还本"]);

function parseLoanRateAdjustmentsText(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return [];
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const parsed = rows.map((line) => {
    const match = /^(\d{4}-\d{2}-\d{2})\s*[,，\s]\s*([0-9]+(?:\.[0-9]+)?)%?$/.exec(line);
    if (!match) throw new Error(`历史利率格式不正确：${line}`);
    return {
      effectiveDate: match[1],
      annualRate: Number(match[2]),
    };
  });
  const invalid = parsed.find((item) => !Number.isFinite(item.annualRate) || item.annualRate <= 0);
  if (invalid) throw new Error(`历史利率不正确：${invalid.effectiveDate}`);
  return normalizeLoanRateAdjustments(parsed);
}

function calculateLoanPlanAmount(params: {
  principal: number;
  annualRate: number | null;
  totalRuns: number;
  intervalMonths: number;
  repaymentMethod: string;
}) {
  return calcLoanScheduledAmount(params);
}

export async function createDebtTransaction(formData: FormData) {
  "use server";

  const mode = String(formData.get("mode") ?? "").trim();
  const loanFundingMode = String(formData.get("loanFundingMode") ?? "cash_disbursement").trim();
  const editEntryId = String(formData.get("editEntryId") ?? "").trim();
  const debtAccountId = String(formData.get("debtAccountId") ?? "").trim();
  const debtObjectId = String(formData.get("debtObjectId") ?? formData.get("debtInstitutionId") ?? "").trim();
  const debtItemName = String(formData.get("debtItemName") ?? "").trim();
  const cashAccountId = String(formData.get("cashAccountId") ?? "").trim();
  const dateStr = String(formData.get("date") ?? "").trim();
  const principal = parseMoneyInput(formData.get("principal"));
  const principalAbs = Math.abs(principal);
  const rawInterest = Math.abs(parseMoneyInput(formData.get("interest")));
  const penalty = Math.abs(parseMoneyInput(formData.get("penalty")));
  const prepayStrategyRaw = String(formData.get("prepayStrategy") ?? "").trim();
  const prepayStrategy = normalizeLoanPrepayStrategy(prepayStrategyRaw);
  const annualRateRaw = String(formData.get("annualRate") ?? "").trim();
  const mortgageLprDiscountRaw = String(formData.get("mortgageLprDiscount") ?? "").trim();
  const repaymentMethod = normalizeLoanRepaymentMethod(String(formData.get("repaymentMethod") ?? "").trim());
  const isInstallmentRepayment = isInstallmentRepaymentMethod(repaymentMethod);
  const loanYearsRaw = parseInt(String(formData.get("loanYears") ?? ""), 10);
  const repaymentIntervalMonthsRaw = parseInt(String(formData.get("repaymentIntervalMonths") ?? "1"), 10);
  const loanTotalRunsRaw = parseInt(String(formData.get("loanTotalRuns") ?? ""), 10);
  const firstRepaymentDateStr = String(formData.get("firstRepaymentDate") ?? "").trim();
  const createRepaymentPlan = String(formData.get("createRepaymentPlan") ?? "false") === "true";
  // Loan repayment execution mode: true = auto-debit (cash transfer when due,
  // mortgage-style); false = bill only (generate the bill, pay manually).
  const autoDebit = String(formData.get("autoDebit") ?? "true") !== "false";
  const createHistoricalRepaymentRecords = String(formData.get("createHistoricalRepaymentRecords") ?? "false") === "true";
  const historicalLoanRatesText = String(formData.get("historicalLoanRates") ?? "").trim();
  const acceptedLprRateEffectiveDateStr = String(formData.get("acceptedLprRateEffectiveDate") ?? "").trim();
  const acceptedLprAnnualRateRaw = String(formData.get("acceptedLprAnnualRate") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();
  const { householdId } = await getHouseholdScope();
  let recalculateAfterSave: { accountId: string; startDate: string } | null = null;
  const isFinancedPurchase = mode === "borrow_in" && loanFundingMode === "financed_purchase";

  if (!["borrow_in", "repay_out", "prepay_out", "lend_out", "collect_in"].includes(mode)) {
    return { ok: false as const, error: "操作类型不正确" };
  }
  if ((!debtAccountId && !debtObjectId) || !cashAccountId) {
    return { ok: false as const, error: "请选择往来对象和资金账户" };
  }
  if (debtAccountId && debtAccountId === cashAccountId) {
    return { ok: false as const, error: "往来对象账户与资金账户不能相同" };
  }
  if (principalAbs <= 0) {
    return { ok: false as const, error: "请输入正确的金额" };
  }
  const interest = mode === "prepay_out" ? 0 : rawInterest;
  if (interest < 0) {
    return { ok: false as const, error: "利息不能小于 0" };
  }
  if (penalty < 0) {
    return { ok: false as const, error: "手续费不能小于 0" };
  }
  const debtPrincipalForRecord = principalAbs;
  const realizedProfitForRecord = interest > 0
    ? (mode === "collect_in" ? Math.abs(interest) : -Math.abs(interest))
    : null;

  const date = dateStr && !Number.isNaN(new Date(dateStr).getTime()) ? new Date(dateStr) : new Date();
  const mortgageLprDiscount = mortgageLprDiscountRaw
    ? parseFloat(mortgageLprDiscountRaw)
    : null;
  if (
    mortgageLprDiscountRaw &&
    (mortgageLprDiscount == null || !Number.isFinite(mortgageLprDiscount) || mortgageLprDiscount <= 0)
  ) {
    return { ok: false as const, error: "LPR 利率折扣不正确" };
  }
  const annualRate = annualRateRaw
    ? parseFloat(annualRateRaw)
    : mortgageLprDiscount != null
      ? Math.round(MORTGAGE_BASE_BENCHMARK_RATE * mortgageLprDiscount * 1000) / 1000
      : isInstallmentRepayment
        ? 0
        : null;
  if (
    annualRateRaw &&
    (annualRate == null || !Number.isFinite(annualRate) || annualRate < 0 || (!isInstallmentRepayment && annualRate <= 0))
  ) {
    return { ok: false as const, error: "年利率不正确" };
  }
  const acceptedLprRateEffectiveDate = acceptedLprRateEffectiveDateStr
    ? parseDateOnlyUtc(acceptedLprRateEffectiveDateStr)
    : null;
  const acceptedLprAnnualRate = acceptedLprAnnualRateRaw ? parseFloat(acceptedLprAnnualRateRaw) : null;
  if (acceptedLprRateEffectiveDateStr && !acceptedLprRateEffectiveDate) {
    return { ok: false as const, error: "接受的 LPR 利率生效日期不正确" };
  }
  if (
    acceptedLprAnnualRateRaw &&
    (acceptedLprAnnualRate == null || !Number.isFinite(acceptedLprAnnualRate) || acceptedLprAnnualRate <= 0)
  ) {
    return { ok: false as const, error: "接受的 LPR 年利率不正确" };
  }
  const firstRepaymentDate = firstRepaymentDateStr ? parseDateOnlyUtc(firstRepaymentDateStr) : null;
  if (firstRepaymentDateStr && !firstRepaymentDate) return { ok: false as const, error: "首次还款日不正确" };
  const repaymentIntervalMonths =
    Number.isFinite(repaymentIntervalMonthsRaw) && repaymentIntervalMonthsRaw > 0 ? repaymentIntervalMonthsRaw : 1;
  const loanTotalRuns =
    Number.isFinite(loanTotalRunsRaw) && loanTotalRunsRaw > 0
      ? loanTotalRunsRaw
      : Number.isFinite(loanYearsRaw) && loanYearsRaw > 0
        ? loanYearsRaw * 12
        : NaN;
  const isFixedRepaymentMethod = FIXED_LOAN_REPAYMENT_METHODS.has(repaymentMethod);
  const calculatedPlanAmount = calculateLoanPlanAmount({
    principal: principalAbs,
    annualRate,
    totalRuns: loanTotalRuns,
    intervalMonths: repaymentIntervalMonths,
    repaymentMethod,
  });
  const repaymentPlanAmount = calculatedPlanAmount;

  if (mode === "borrow_in" && isFixedRepaymentMethod) {
    if (annualRate == null || !Number.isFinite(annualRate) || annualRate < 0 || (!isInstallmentRepayment && annualRate <= 0)) {
      return { ok: false as const, error: "固定还款方式需要填写年利率" };
    }
    if (!Number.isFinite(repaymentIntervalMonths) || repaymentIntervalMonths <= 0) {
      return { ok: false as const, error: "固定还款方式需要填写还款周期" };
    }
    if (!Number.isFinite(loanTotalRuns) || loanTotalRuns <= 0) {
      return { ok: false as const, error: "固定还款方式需要填写总期数" };
    }
    if (!firstRepaymentDate) {
      return { ok: false as const, error: "固定还款方式需要填写首次还款日" };
    }
    if (!repaymentPlanAmount || repaymentPlanAmount <= 0) {
      return { ok: false as const, error: "无法计算计划还款金额，请检查借款总额、利率和期数" };
    }
  }
  let historicalLoanRateAdjustments: ReturnType<typeof parseLoanRateAdjustmentsText> = [];
  try {
    historicalLoanRateAdjustments = parseLoanRateAdjustmentsText(historicalLoanRatesText);
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : "历史利率格式不正确" };
  }
  if (historicalLoanRateAdjustments.length === 0 && mortgageLprDiscount != null && mortgageLprDiscount > 0) {
    historicalLoanRateAdjustments = buildMortgageLprRateAdjustments({
      discount: mortgageLprDiscount,
      throughDate: formatDateUtc(new Date()),
    });
  }

  try {
    let resolvedDebtAccountId = debtAccountId;
    let createdRepaymentPlanId: string | null = null;
    const affectedAccountIds = new Set<string>();
    await prisma.$transaction(async (tx) => {
      const debtDirection = mode === "borrow_in" || mode === "repay_out" || mode === "prepay_out" ? "payable" : "receivable";
      const cashAccount = await tx.account.findUnique({ where: { id: cashAccountId } });
      const debtAccount = debtObjectId
        ? await resolveOrCreateDebtAccount(tx, householdId, debtObjectId, debtDirection, debtItemName)
        : await tx.account.findUnique({
            where: { id: debtAccountId },
            include: { Institution: { select: { id: true, name: true, type: true } }, Counterparty: { select: { id: true, name: true, type: true } } },
          });

      if (!debtAccount || debtAccount.kind !== AccountKind.loan) {
        throw new Error("往来对象账户不存在");
      }
      if (!cashAccount || isPureInvestmentAccount(cashAccount) || cashAccount.kind === AccountKind.loan) {
        throw new Error("资金账户不正确");
      }
      const isCounterpartyDebtAccount = !!debtAccount.counterpartyId && !debtAccount.institutionId;
      if (!isCounterpartyDebtAccount && (mode === "repay_out" || mode === "prepay_out") && debtAccount.debtDirection !== "payable") {
        throw new Error("还款只能选择已有借款项");
      }
      if (!isCounterpartyDebtAccount && mode === "lend_out" && debtAccount.debtDirection !== "receivable") {
        throw new Error("借出只能选择已有借出项或往来对象");
      }
      if (!isCounterpartyDebtAccount && mode === "collect_in" && debtAccount.debtDirection !== "receivable") {
        throw new Error("收回只能选择已有借出项");
      }
      const settlementTransferCategory = await ensureSettlementTransferCategory(tx, householdId);
      resolvedDebtAccountId = debtAccount.id;
      if (
        acceptedLprRateEffectiveDate &&
        acceptedLprAnnualRate != null &&
        mode === "repay_out"
      ) {
        const repaymentPlan = await tx.regularInvestPlan.findFirst({
          where: {
            householdId,
            accountId: debtAccount.id,
            fundCode: "loan_repayment",
            status: { in: [RegularInvestStatus.active, RegularInvestStatus.paused] },
          },
          orderBy: [{ status: "asc" }, { nextRunDate: "asc" }],
          select: { id: true },
        });
        await tx.loanRateAdjustment.deleteMany({
          where: {
            householdId,
            accountId: debtAccount.id,
            effectiveDate: acceptedLprRateEffectiveDate,
          },
        });
        await tx.loanRateAdjustment.create({
          data: {
            householdId,
            accountId: debtAccount.id,
            regularInvestPlanId: repaymentPlan?.id ?? null,
            effectiveDate: acceptedLprRateEffectiveDate,
            annualRate: acceptedLprAnnualRate,
          },
        });
      }
      const outstandingPrincipalBefore = Math.abs(toNumber(debtAccount.balance));
      if (!editEntryId && mode === "prepay_out" && principalAbs - outstandingPrincipalBefore > 0.005) {
        throw new Error(`提前还本金不能超过当前贷款本金余额 ${outstandingPrincipalBefore.toFixed(2)}`);
      }
      if (!editEntryId && mode === "prepay_out" && prepayStrategy === "settle" && Math.abs(principalAbs - outstandingPrincipalBefore) > 0.005) {
        throw new Error(`全部结清时，提前还本金应等于当前贷款本金余额 ${outstandingPrincipalBefore.toFixed(2)}`);
      }
      const isInstitutionBorrow =
        mode === "borrow_in" &&
        !!debtAccount.institutionId &&
        !!debtAccount.Institution &&
        (debtAccount.Institution.type === "bank" || debtAccount.Institution.type === "debt");
      const isFinancedPurchaseForRecord = isInstitutionBorrow && isFinancedPurchase;
      if (editEntryId) {
        if (!["borrow_in", "repay_out", "prepay_out", "lend_out", "collect_in"].includes(mode)) {
          throw new Error("只能在借入、借出、还款、提前还款或收回界面编辑往来款记录");
        }
        const original = await tx.txRecord.findFirst({
          where: {
            id: editEntryId,
            householdId,
            deletedAt: null,
            type: TransactionType.transfer,
          },
        });
        if (!original) throw new Error("原还款记录不存在");
        affectedAccountIds.add(original.accountId);
        if (original.toAccountId) affectedAccountIds.add(original.toAccountId);
        affectedAccountIds.add(cashAccount.id);
        affectedAccountIds.add(debtAccount.id);

        const isDebtAccountFromSide = mode === "borrow_in" || mode === "collect_in";
        const transferFromAccount = isDebtAccountFromSide ? debtAccount : cashAccount;
        const transferToAccount = isFinancedPurchaseForRecord ? null : isDebtAccountFromSide ? cashAccount : debtAccount;
        const transferStatementMonth =
          transferToAccount &&
          (transferToAccount.kind === AccountKind.bank_credit || transferToAccount.kind === AccountKind.loan) &&
          transferToAccount.billingDay
            ? toStatementMonth(date, transferToAccount.billingDay)
            : null;
        await tx.txRecord.update({
          where: { id: original.id },
          data: {
            accountId: transferFromAccount.id,
            accountName: transferFromAccount.name,
            toAccountId: transferToAccount?.id ?? null,
            toAccountName: transferToAccount?.name ?? null,
            amount: mode === "repay_out" || mode === "prepay_out"
              ? -Math.abs(principalAbs + interest + (mode === "prepay_out" ? penalty : 0))
              : mode === "collect_in"
                ? debtPrincipalForRecord + interest
                : -debtPrincipalForRecord,
            debtPrincipalAmount: debtPrincipalForRecord,
            debtInterestAmount: ["repay_out", "lend_out", "collect_in"].includes(mode) ? Math.abs(interest) : 0,
            debtFeeAmount: mode === "prepay_out" ? Math.abs(penalty) : 0,
            realizedProfit: realizedProfitForRecord,
            date,
            note: note || null,
            toNote: mode === "prepay_out" ? encodeLoanPrepayStrategy(prepayStrategy) : original.toNote,
            statementMonth: transferStatementMonth,
            source: isFinancedPurchaseForRecord ? "debt_financed_purchase" : `debt_${mode}`,
            categoryId: settlementTransferCategory?.id ?? null,
            categoryName: settlementTransferCategory?.name ?? "借入借出",
          },
        });
        if (mode === "prepay_out" && transferToAccount?.id) {
          recalculateAfterSave = {
            accountId: transferToAccount.id,
            startDate: formatDateUtc(date),
          };
        }

        await tx.txRecord.updateMany({
          where: {
            householdId,
            id: { not: original.id },
            accountId: original.accountId,
            toAccountId: original.toAccountId,
            date: original.date,
            deletedAt: null,
            type: { not: TransactionType.transfer },
            OR: [
              { source: { in: ["debt_repay_out_interest", "debt_prepay_out_interest", "debt_collect_in_interest", "debt_prepay_out_fee"] } },
              { categoryName: { contains: "利息" } },
              { note: { contains: "利息" } },
              { categoryName: { contains: "手续费" } },
              { note: { contains: "违约金" } },
            ],
          },
          data: { deletedAt: new Date() },
        });
        if (mode === "borrow_in") {
          const existingPlan = await tx.regularInvestPlan.findFirst({
            where: {
              householdId,
              accountId: debtAccount.id,
              fundCode: "loan_repayment",
              status: { in: [RegularInvestStatus.active, RegularInvestStatus.paused] },
            },
            orderBy: [{ status: "asc" }, { nextRunDate: "asc" }],
          });
          if (existingPlan) {
            const intervalMonths = Number.isFinite(repaymentIntervalMonths) && repaymentIntervalMonths > 0
              ? repaymentIntervalMonths
              : existingPlan.intervalValue;
            const totalRuns = Number.isFinite(loanTotalRuns) && loanTotalRuns > 0
              ? loanTotalRuns
              : existingPlan.totalRuns ?? 0;
            const startDate = firstRepaymentDate ?? existingPlan.startDate;
            const executionDay = firstRepaymentDate ? firstRepaymentDate.getUTCDate() : existingPlan.executionDay;
            const title = `还款：${debtAccount.Institution?.name ?? debtAccount.Counterparty?.name ?? debtAccount.name}`;
            const nextRunDate = (existingPlan.executedRuns ?? 0) > 0 && existingPlan.nextRunDate
              ? existingPlan.nextRunDate
              : calcInitialScheduledRunDate(startDate, IntervalUnit.month, intervalMonths, executionDay, false);
            await tx.regularInvestPlan.update({
              where: { id: existingPlan.id },
              data: {
                cashAccountId: cashAccount.id,
                cashAccountName: cashAccount.name,
                amount: Number.isFinite(repaymentPlanAmount) && repaymentPlanAmount != null && repaymentPlanAmount > 0 ? repaymentPlanAmount : (existingPlan.amount ?? 0),
                intervalValue: intervalMonths,
                executionDay,
                startDate,
                nextRunDate,
                totalRuns,
                memo: encodeScheduledTaskMemo({
                  type: "loan_repayment",
                  title,
                  fromAccountId: cashAccount.id,
                  toAccountId: debtAccount.id,
                  annualRate: annualRate ?? null,
                  mortgageLprDiscount: mortgageLprDiscount ?? null,
                  repaymentMethod,
                  repaymentIntervalMonths: intervalMonths,
                  originalTotalRuns: totalRuns,
                  autoDebit,
                }),
              },
            });
            await replaceLoanRateAdjustmentsForAccount(tx, {
              householdId,
              accountId: debtAccount.id,
              regularInvestPlanId: existingPlan.id,
              adjustments: historicalLoanRateAdjustments,
            });
          }
        }
        return;
      }
      const shouldCreateRepaymentPlan =
        mode === "borrow_in" &&
        createRepaymentPlan &&
        !!firstRepaymentDate &&
        !!repaymentPlanAmount &&
        repaymentPlanAmount > 0 &&
        Number.isFinite(loanTotalRuns) &&
        loanTotalRuns > 0;

      const transferFromAccount = mode === "borrow_in" || mode === "collect_in" ? debtAccount : cashAccount;
      const transferToAccount = isFinancedPurchaseForRecord ? null : mode === "borrow_in" || mode === "collect_in" ? cashAccount : debtAccount;
      const transferStatementMonth =
        transferToAccount &&
        (transferToAccount.kind === AccountKind.bank_credit || transferToAccount.kind === AccountKind.loan) &&
        transferToAccount.billingDay
          ? toStatementMonth(date, transferToAccount.billingDay)
          : null;

      await tx.txRecord.create({
        data: {
          accountId: transferFromAccount.id,
          accountName: transferFromAccount.name,
          toAccountId: transferToAccount?.id ?? null,
          toAccountName: transferToAccount?.name ?? null,
          amount: mode === "repay_out" || mode === "prepay_out"
            ? -Math.abs(principalAbs + interest + (mode === "prepay_out" ? penalty : 0))
            : mode === "collect_in"
              ? debtPrincipalForRecord + interest
              : -debtPrincipalForRecord,
          debtPrincipalAmount: debtPrincipalForRecord,
          debtInterestAmount: ["repay_out", "lend_out", "collect_in"].includes(mode) ? Math.abs(interest) : null,
          debtFeeAmount: mode === "prepay_out" ? Math.abs(penalty) : null,
          realizedProfit: realizedProfitForRecord,
          type: TransactionType.transfer,
          date,
          note: mode === "borrow_in"
            ? (isInstitutionBorrow || isFixedRepaymentMethod)
              ? [
                  note || (isFinancedPurchaseForRecord ? "消费分期" : isInstitutionBorrow ? "机构借入" : "借入"),
                  `还款方式：${repaymentMethod}`,
                  isFixedRepaymentMethod && Number.isFinite(repaymentIntervalMonths) && repaymentIntervalMonths > 0
                    ? `周期：每${repaymentIntervalMonths === 1 ? "月" : `${repaymentIntervalMonths}个月`}`
                    : "",
                  isFixedRepaymentMethod && Number.isFinite(loanTotalRuns) && loanTotalRuns > 0 ? `期数：${loanTotalRuns}` : "",
                  isFixedRepaymentMethod && annualRate != null ? `年利率：${annualRate}%` : "",
                  isInstitutionBorrow && isFixedRepaymentMethod && mortgageLprDiscount != null ? `LPR折扣：${mortgageLprDiscount}` : "",
                ].filter(Boolean).join("；")
              : note || "借入"
            : note || null,
          toNote: mode === "prepay_out" ? encodeLoanPrepayStrategy(prepayStrategy) : null,
          statementMonth: transferStatementMonth,
          source: isFinancedPurchaseForRecord ? "debt_financed_purchase" : `debt_${mode}`,
          categoryId: settlementTransferCategory?.id ?? null,
          categoryName: settlementTransferCategory?.name ?? "借入借出",
          householdId,
        },
      });

      if (shouldCreateRepaymentPlan && firstRepaymentDate) {
        const totalRuns = loanTotalRuns;
        const executionDay = firstRepaymentDate.getUTCDate();
        const title = `还款：${debtAccount.Institution?.name ?? debtAccount.Counterparty?.name ?? debtAccount.name}`;
        const plan = await tx.regularInvestPlan.create({
          data: {
            accountId: debtAccount.id,
            accountName: debtAccount.name,
            cashAccountId: cashAccount.id,
            cashAccountName: cashAccount.name,
            fundCode: "loan_repayment",
            fundName: title,
            fundProductType: null,
            amount: repaymentPlanAmount,
            intervalUnit: IntervalUnit.month,
            intervalValue: repaymentIntervalMonths,
            executionDay,
            startDate: firstRepaymentDate,
            nextRunDate: calcInitialScheduledRunDate(firstRepaymentDate, IntervalUnit.month, repaymentIntervalMonths, executionDay, false),
            endDate: null,
            totalRuns,
            status: RegularInvestStatus.active,
            feeRate: 0,
            confirmDays: 0,
            arrivalDays: 0,
            memo: encodeScheduledTaskMemo({
              type: "loan_repayment",
              title,
              fromAccountId: cashAccount.id,
              toAccountId: debtAccount.id,
              annualRate: annualRate ?? null,
              mortgageLprDiscount: mortgageLprDiscount ?? null,
              repaymentMethod,
              repaymentIntervalMonths,
              originalTotalRuns: totalRuns,
              autoDebit,
            }),
            skipPendingPreceding: false,
            householdId,
          },
        });
        await replaceLoanRateAdjustmentsForAccount(tx, {
          householdId,
          accountId: debtAccount.id,
          regularInvestPlanId: plan.id,
          adjustments: historicalLoanRateAdjustments,
        });
        createdRepaymentPlanId = plan.id;
      }

      if (mode === "prepay_out") {
        recalculateAfterSave = {
          accountId: debtAccount.id,
          startDate: formatDateUtc(date),
        };
      }
    });

    await Promise.all([
      ...Array.from(new Set([resolvedDebtAccountId, cashAccountId, ...affectedAccountIds].filter(Boolean)))
        .map((id) => recalcAndSaveAccountBalance(id).catch(() => {})),
    ]);
    await invalidateCreditCardCycleCacheForAccountIds([
      resolvedDebtAccountId,
      cashAccountId,
      ...affectedAccountIds,
    ]).catch(() => {});
    let historicalGenerationWarning: string | null = null;
    if (createdRepaymentPlanId && createHistoricalRepaymentRecords && !isFinancedPurchase) {
      const createdPlan = await prisma.regularInvestPlan.findFirst({
        where: { id: createdRepaymentPlanId, householdId },
      });
      if (createdPlan) {
        try {
          await executeNonFundScheduledTaskPlan({
            householdId,
            plan: createdPlan,
            task: decodeScheduledTaskMemo(createdPlan.memo),
            initialLoanPrincipal: principalAbs,
          });
        } catch (error) {
          historicalGenerationWarning = error instanceof Error ? error.message : "历史还款记录补生成失败";
        }
      }
    }
    revalidateAfterTxChange();
    if (historicalGenerationWarning) {
      return {
        ok: true as const,
        warning: `借款和还款计划已保存，但历史还款记录没有补生成：${historicalGenerationWarning}`,
        recalculateAfterSave,
      };
    }
    return { ok: true as const, recalculateAfterSave };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : "借还款失败" };
  }
}
