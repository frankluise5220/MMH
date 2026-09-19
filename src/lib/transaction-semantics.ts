import { toStatementMonth } from "@/lib/date-utils";
export const ENTRY_ORIGIN_MANUAL = "manual" as const;
export const ENTRY_ORIGIN_AI_IMPORT = "ai_import" as const;
export const ENTRY_ORIGIN_EXCEL_IMPORT = "excel_import" as const;
export const ENTRY_ORIGIN_SCHEDULED_TASK = "scheduled_task" as const;
export const ENTRY_ORIGIN_EMAIL_IMPORT = "email_import" as const;

type CreditCardRepaymentLike = {
  readonly type?: string | null;
  readonly accountKind?: string | null;
  readonly toAccountKind?: string | null;
};

type StatementAccountLike = {
  readonly kind?: string | null;
  readonly billingDay?: number | null;
  readonly billingDayTxPeriod?: string | null;
};

export const ENTRY_ORIGIN_VALUES = [
  ENTRY_ORIGIN_MANUAL,
  ENTRY_ORIGIN_AI_IMPORT,
  ENTRY_ORIGIN_EXCEL_IMPORT,
  ENTRY_ORIGIN_SCHEDULED_TASK,
  ENTRY_ORIGIN_EMAIL_IMPORT,
] as const;

export type EntryOrigin = (typeof ENTRY_ORIGIN_VALUES)[number];

export function isEntryOrigin(value: unknown): value is EntryOrigin {
  return ENTRY_ORIGIN_VALUES.includes(value as EntryOrigin);
}

export function normalizeEntryOrigin(value: string | null | undefined): EntryOrigin {
  return isEntryOrigin(value) ? value : ENTRY_ORIGIN_MANUAL;
}

export const TRANSACTION_SOURCE_MANUAL = "manual" as const;
export const TRANSACTION_SOURCE_INSURANCE = "insurance" as const;
export const TRANSACTION_SOURCE_REGULAR_INVEST = "regular_invest" as const;
export const TRANSACTION_SOURCE_REGULAR_INVEST_REFUND = "regular_invest_refund" as const;
export const TRANSACTION_SOURCE_FUND_UNITS_RECONCILE = "fund_units_reconcile" as const;
export const TRANSACTION_SOURCE_SCHEDULED_TASK = "scheduled_task" as const;
export const TRANSACTION_SOURCE_STATEMENT_IMPORT = "statement_import" as const;
/**
 * 债券执行器（买入/付息/赎回）写入的流水 source。
 * 与存款侧的 "deposit" 同构：由业务执行器写、不走通用 scheduled_task 分支，
 * 因此「计划任务」页统计「已执行次数」时必须按 source 单独匹配。
 */
export const TRANSACTION_SOURCE_BOND = "bond" as const;

export function isLicensedInsuranceEntry(entry: { source?: string | null; insuranceProductId?: string | null }) {
  return entry.source === TRANSACTION_SOURCE_INSURANCE || Boolean(entry.insuranceProductId);
}

export function isRegularInvestRefundEntry(entry: { source?: string | null; fundSubtype?: string | null }) {
  return entry.fundSubtype === "buy_failed" && entry.source === TRANSACTION_SOURCE_REGULAR_INVEST_REFUND;
}

export function isFundUnitsReconcileEntry(entry: { source?: string | null }) {
  return entry.source === TRANSACTION_SOURCE_FUND_UNITS_RECONCILE;
}

export function isGeneratedScheduledRecord(entry: { source?: string | null; entryOrigin?: string | null; regularInvestPlanId?: string | null }) {
  return entry.entryOrigin === ENTRY_ORIGIN_SCHEDULED_TASK || entry.source === TRANSACTION_SOURCE_SCHEDULED_TASK;
}

export function recordMatchesRegularInvestPlan(taskType: string | null | undefined, entry: { source?: string | null }) {
  if (taskType === "fund_regular_invest") return entry.source === TRANSACTION_SOURCE_REGULAR_INVEST;
  if (taskType === "insurance_premium") return entry.source === TRANSACTION_SOURCE_INSURANCE;
  // 存款到期/取息的记录由存款执行器写入，source 固定为 "deposit"（本金赎回与利息收入同源），
  // 不走通用 scheduled_task 分支；贷款/转账等其它系统任务仍按 scheduled_task 匹配。
  if (taskType === "deposit_maturity" || taskType === "deposit_interest_payout") {
    return entry.source === "deposit";
  }
  // 债券到期/付息同构：由债券执行器写入，source 固定为 "bond"（付息的生息+取息两条同源）。
  // 债券「买入/赎回」虽然也是 source="bond"，但它们不带 regularInvestPlanId，
  // 不会进入按计划分组的统计，因此不会污染「已执行次数」。
  if (taskType === "bond_maturity" || taskType === "bond_interest_payout") {
    return entry.source === TRANSACTION_SOURCE_BOND;
  }
  return entry.source === TRANSACTION_SOURCE_SCHEDULED_TASK;
}

export const CREDIT_CARD_REPAYMENT_BUSINESS_TYPE = "credit_card_repayment" as const;
export const CREDIT_CARD_REPAYMENT_CATEGORY_NAME = "信用卡还款" as const;
export type CreditCardRepaymentBusinessType = typeof CREDIT_CARD_REPAYMENT_BUSINESS_TYPE;

const REPAYMENT_SOURCE_ACCOUNT_KINDS = new Set(["cash", "bank_debit", "ewallet"]);
const REPAYMENT_IMPORT_SOURCE_ACCOUNT_KINDS = new Set(["bank_debit", "ewallet"]);

export function isCreditCardRepaymentBusinessType(value: unknown) {
  return value === CREDIT_CARD_REPAYMENT_BUSINESS_TYPE;
}

export function isCreditCardRepaymentSourceAccountKind(kind: string | null | undefined) {
  return REPAYMENT_SOURCE_ACCOUNT_KINDS.has(kind ?? "");
}

export function isCreditCardRepaymentImportSourceAccountKind(kind: string | null | undefined) {
  return REPAYMENT_IMPORT_SOURCE_ACCOUNT_KINDS.has(kind ?? "");
}

export function isCreditCardRepaymentTargetAccountKind(kind: string | null | undefined) {
  return kind === "bank_credit";
}

export function isCreditCardRepaymentTransfer(entry: CreditCardRepaymentLike) {
  return (
    entry.type === "transfer" &&
    isCreditCardRepaymentSourceAccountKind(entry.accountKind) &&
    isCreditCardRepaymentTargetAccountKind(entry.toAccountKind)
  );
}

function statementMonthForBillSide(date: Date, account: StatementAccountLike | null | undefined) {
  if (!account?.billingDay) return null;
  if (account.kind !== "bank_credit" && account.kind !== "loan" && account.kind !== "settlement") return null;
  return toStatementMonth(date, account.billingDay, account.billingDayTxPeriod);
}

/**
 * Returns true for transfer records whose cash movement represents a debt-principal
 * flow (borrow/lend, repayment, collection) and should not be counted as income
 * or expense in cash-flow statistics.  These are:
 *   debt_borrow_in         — money I borrowed (principal enters my cash account)
 *   debt_financed_purchase — installment purchase (principal enters my cash account)
 *   debt_lend_out          — money I lent out (principal leaves my cash account)
 *   debt_collect_in        — money I borrowed / collected back (principal enters my cash account)
 *   debt_repay_out         — principal repaid to a creditor
 *   debt_prepay_out        — early repayment of principal
 *   scheduled_task         — scheduled repayment (same as debt_repay_out)
 *
 * Only the interest portion (handled separately via getBusinessResultStatisticItems)
 * should appear in income/expense statistics.
 *
 * ⚠️ 必须包含 `debt_borrow_in` / `debt_financed_purchase`：当 scope 排除债务账户时，
 * 这两种 source 的现金方向（现金账户 in、债务账户 out）会触发 `isToSelf && !isFromSelf`，
 * 本金会落入"收入来源"饼图。这是统计页与 API 端点都必须调用的过滤函数，
 * 任何漏配都会让借到的钱变成"收入"被错误呈现。
 */
/** 债务账户 kind：往来款（settlement）与贷款（loan，含银行贷与往来款贷款）。 */
export function isDebtAccountKind(kind?: string | null) {
  return kind === "settlement" || kind === "loan";
}

/**
 * 以账户现状判断这笔转账是否仍构成债务活动。
 *
 * `source` 只记录写入时的业务语义（借出/收回/借入/还款）；账户被改成普通资金账户后，
 * 历史 `source` 不应再让该行按债务口径展示或统计。账户 kind 是账户当前属性的唯一权威。
 *
 * 返回 `null` 表示"两端都没有拿到账户 kind、无法判定"，由调用方维持原行为，避免信息缺失时
 * 静默改变统计口径。
 */
export function isDebtActivityByAccount(
  entry: { accountKind?: string | null; toAccountKind?: string | null } | null | undefined,
) {
  if (!entry) return null;
  const sourceKind = entry.accountKind ?? null;
  const targetKind = entry.toAccountKind ?? null;
  if (!sourceKind && !targetKind) return null;
  return isDebtAccountKind(sourceKind) || isDebtAccountKind(targetKind);
}

const DEBT_PRINCIPAL_SOURCES = new Set([
  "debt_borrow_in",
  "debt_financed_purchase",
  "debt_lend_out",
  "debt_collect_in",
  "debt_repay_out",
  "debt_prepay_out",
  "scheduled_task",
]);

export function isDebtPrincipalSource(source?: string | null) {
  return DEBT_PRINCIPAL_SOURCES.has(source ?? "");
}

export function isDebtPrincipalTransfer(entry: {
  source?: string | null;
  accountKind?: string | null;
  toAccountKind?: string | null;
} | null | undefined) {
  if (!isDebtPrincipalSource(entry?.source)) return false;
  // 账户两端都已不是债务账户时，历史 source 不再按债务本金处理；拿不到账户信息时保持原口径。
  return isDebtActivityByAccount(entry) ?? true;
}

/**
 * 资金统计收入/支出（含收入来源、支出来源饼图）应排除的债务本金现金流。
 *
 * 比 {@link isDebtPrincipalTransfer} 更严：只要账户一端当前是 loan/settlement，
 * 即便 source 不是 debt_*（手工/代付导入），本金也不进收入/支出。
 * 利息仍走 getBusinessResultStatisticItems，不在这里排除。
 *
 * ⚠️ 调用方必须用**全账本**账户 kind 表（含挂往来对象、已停用账户）。
 * 统计页筛选下拉会排除 `counterpartyId != null` 的往来款账户；若用那份列表
 * 建 kind 表，一端是资金账户、一端是往来款时 `isDebtActivityByAccount`
 * 会得到 false，本金被当成跨范围转账打进饼图。
 */
export function isDebtPrincipalCashFlow(entry: {
  source?: string | null;
  accountKind?: string | null;
  toAccountKind?: string | null;
} | null | undefined) {
  if (isDebtActivityByAccount(entry) === true) return true;
  return isDebtPrincipalTransfer(entry);
}

export function statementMonthForTransfer(
  date: Date,
  fromAccount: StatementAccountLike | null | undefined,
  toAccount: StatementAccountLike | null | undefined,
) {
  return statementMonthForBillSide(date, toAccount) ?? statementMonthForBillSide(date, fromAccount);
}
