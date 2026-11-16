/**
 * 信用卡账单摘要的共用词表与提取器。
 *
 * 「本期应还金额」是锁定该账期账单金额的唯一依据（BillOverride），PDF/文本、
 * Excel 模板、批量导入三条通道必须从同一份词表取值，否则同一张账单换个格式就锁不上。
 * 各银行模板里出现过的写法都汇总在下面的常量里，新增一家银行只补词表，不要另写提取器。
 *
 * 注意：通用词表里故意不放裸「应还金额」——「本期最低应还金额 ￥133.13」里就含这四个字，
 * 通用正则只允许标签与数字之间出现空白/字母/括号，会一路吃到最低还款额上。
 * 只有自己先排除「最低还款」行的模板（招行/民生）才用带 「应还金额」的宽词表。
 */

import { CREDIT_CARD_MONTH_END_BILLING_DAY } from "@/lib/credit/rules";

export const CREDIT_CARD_STATEMENT_AMOUNT_LABELS: readonly string[] = [
  // 精确词优先：标签与金额之间常夹着「金额」「（元）」这类整体，必须整词列进来。
  "本期应还金额（元）",
  "本期应还金额(元)",
  "本期应还金额",
  "本期账单应还金额",
  "本期应还款金额",
  "本期应还款总额",
  "本期应还款额",
  "本期应还款",
  "本期应还总额",
  "本期应缴金额",
  "本期应缴余额",
  "本期应还",
  "本期账单金额",
  "本期余额",
  "New Balance",
  "Total Due",
  "Amount Due",
];

/** 供已排除「最低还款」行的模板使用（招行/民生）。 */
export const CREDIT_CARD_STATEMENT_AMOUNT_TEMPLATE_LABELS: readonly string[] = [
  ...CREDIT_CARD_STATEMENT_AMOUNT_LABELS,
  "应还金额",
];

export const CREDIT_CARD_MINIMUM_PAYMENT_LABELS: readonly string[] = [
  "本期最低应还金额",
  "本期最低还款额",
  "最低应还金额",
  "最低还款额",
  "Minimum Payment",
  "Min. Payment",
];

export const CREDIT_CARD_CREDIT_LIMIT_LABELS: readonly string[] = [
  "总授信额度",
  "总信用额度",
  "信用额度",
  "固定额度",
  "卡片额度",
  "Credit Limit",
];

export const CREDIT_CARD_BILLING_DATE_LABELS: readonly string[] = [
  "本期账单日",
  "账单日",
  "Statement Date",
  "Billing Date",
];

export const CREDIT_CARD_DUE_DATE_LABELS: readonly string[] = [
  "本期最后还款日",
  "最后还款日",
  "到期还款日",
  "本期还款日",
  "还款日",
  "Payment Due Date",
  "Due Date",
];

export const CREDIT_CARD_PERIOD_LABELS: readonly string[] = [
  "本期账单周期",
  "账单周期",
  "账单期间",
  "Statement Period",
  "Statement Cycle",
];

export type CreditCardStatementSummary = {
  statementAmount?: number;
  minimumPayment?: number;
  creditLimit?: number;
  billingDay?: number;
  repaymentDay?: number;
  statementPeriodStart?: string;
  statementPeriodEnd?: string;
  statementDueDate?: string;
};

type ParsedDay = { ymd: string; day: number };

const STATEMENT_AMOUNT_NOISE_RE = /(积分|Bonus\s*Points?|Reward\s*Points?|Points?\b|Rewards?\b)/i;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripMarkup(value: string) {
  return String(value ?? "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(?:td|th|tr|p|div|li)>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&yen;/gi, "¥")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"');
}

function parseAmount(value?: string) {
  const raw = String(value ?? "").replace(/,/g, "").trim();
  const match = raw.match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const amount = Number(match[0]);
  return Number.isFinite(amount) ? amount : undefined;
}

function amountAfterLabels(
  text: string,
  labels: readonly string[],
  reject?: (context: string) => boolean,
) {
  for (const label of labels) {
    const pattern = new RegExp(
      `${escapeRegExp(label)}((?:\\s|[A-Za-z/()（）&-]){0,80})(?:人民币|RMB|CNY|￥|¥)?\\s*(-?[\\d,]+(?:\\.\\d+)?)`,
      "gi",
    );
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const suffix = text
        .slice(pattern.lastIndex, pattern.lastIndex + 12)
        .match(/^[ \t\u00a0]*(?:积分|Bonus\s*Points?|Reward\s*Points?|Points?\b|Rewards?\b)/i)?.[0] ?? "";
      const context = `${label}${match[1] ?? ""}${match[2] ?? ""}${suffix}`;
      if (STATEMENT_AMOUNT_NOISE_RE.test(context)) continue;
      if (reject?.(context)) continue;
      const amount = parseAmount(match[2]);
      if (amount !== undefined) return amount;
    }
  }
  return undefined;
}

function parseDay(value?: string): ParsedDay | null {
  const match = String(value ?? "").match(/(\d{4})[年\/\-.](\d{1,2})[月\/\-.](\d{1,2})/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!(year >= 1990 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31)) return null;
  const ymd = `${match[1]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return { ymd, day };
}

function dayAfterLabels(text: string, labels: readonly string[]): ParsedDay | null {
  for (const label of labels) {
    const match = text.match(
      new RegExp(`${escapeRegExp(label)}(?:\\s|[A-Za-z/()（）&-]){0,80}(\\d{4}[年\\/\\-.]\\d{1,2}[月\\/\\-.]\\d{1,2})`, "i"),
    );
    const parts = parseDay(match?.[1]);
    if (parts) return parts;
  }
  return null;
}

/** 「2026年01月10日 — 2026年02月09日」这种区间，标签与区间分开匹配。 */
const DATE_RANGE_SOURCE =
  "(\\d{4}[年\\/\\-.]\\d{1,2}[月\\/\\-.]\\d{1,2})日?\\s*[-~至—–]{1,2}\\s*(\\d{4}[年\\/\\-.]\\d{1,2}[月\\/\\-.]\\d{1,2})";

function rangeFromMatch(value?: string, value2?: string) {
  const start = parseDay(value);
  const end = parseDay(value2);
  if (!start || !end) return null;
  return { start, end };
}

function periodRange(text: string) {
  // 先认「账单周期/账单期间」标签后面的区间：账单里另有「本期 01-10 ~ 02-09」这类
  // 无关区间时，直接吃第一个区间会取错账期。
  for (const label of CREDIT_CARD_PERIOD_LABELS) {
    const match = text.match(new RegExp(`${escapeRegExp(label)}[\\s:：]{0,4}${DATE_RANGE_SOURCE}`, "i"));
    const range = rangeFromMatch(match?.[1], match?.[2]);
    if (range) return range;
  }
  const match = text.match(new RegExp(DATE_RANGE_SOURCE));
  return rangeFromMatch(match?.[1], match?.[2]);
}

/**
 * 从整份账单文本里抽取账单摘要。
 * Excel 通道把整表按行拼成文本后同样调用这里，和 PDF/文本通道吃同一份词表。
 */
export function extractCreditCardStatementSummary(text: string): CreditCardStatementSummary {
  const plain = stripMarkup(text);
  const period = periodRange(plain);
  const billingDate = dayAfterLabels(plain, CREDIT_CARD_BILLING_DATE_LABELS);
  const dueDate = dayAfterLabels(plain, CREDIT_CARD_DUE_DATE_LABELS);
  const statementAmount = amountAfterLabels(plain, CREDIT_CARD_STATEMENT_AMOUNT_LABELS, (context) =>
    // 「本期应还金额…= 上期账单金额」是口径说明，不是本期数值。
    /(上期账单金额|上月账单金额|Previous\s+Balance)/i.test(context),
  );
  const minimumPayment = amountAfterLabels(plain, CREDIT_CARD_MINIMUM_PAYMENT_LABELS, (context) =>
    /累计|Annual/i.test(context),
  );
  const creditLimit = amountAfterLabels(plain, CREDIT_CARD_CREDIT_LIMIT_LABELS);

  return {
    statementAmount,
    minimumPayment,
    creditLimit,
    billingDay: billingDate?.day,
    repaymentDay: dueDate?.day,
    statementPeriodStart: period?.start.ymd,
    statementPeriodEnd: period?.end.ymd ?? billingDate?.ymd,
    statementDueDate: dueDate?.ymd,
  };
}

/** 只保留有值的摘要字段，避免往 _meta 里写一堆 undefined。 */
export function creditCardSummaryMeta(summary: CreditCardStatementSummary) {
  const meta: CreditCardStatementSummary = {};
  if (summary.statementAmount !== undefined) meta.statementAmount = summary.statementAmount;
  if (summary.minimumPayment !== undefined) meta.minimumPayment = summary.minimumPayment;
  if (summary.creditLimit !== undefined) meta.creditLimit = summary.creditLimit;
  if (summary.billingDay !== undefined) meta.billingDay = summary.billingDay;
  if (summary.repaymentDay !== undefined) meta.repaymentDay = summary.repaymentDay;
  if (summary.statementPeriodStart !== undefined) meta.statementPeriodStart = summary.statementPeriodStart;
  if (summary.statementPeriodEnd !== undefined) meta.statementPeriodEnd = summary.statementPeriodEnd;
  if (summary.statementDueDate !== undefined) meta.statementDueDate = summary.statementDueDate;
  return meta;
}

export type CreditCardProfileSnapshot = {
  billingDay?: number | null;
  repaymentDay?: number | null;
  creditLimit?: number | null;
};

export type CreditCardProfileMismatch = {
  field: "billingDay" | "repaymentDay" | "creditLimit";
  statementValue: number;
  accountValue: number;
};

/**
 * 月末日期在档案里记 31（与 `credit/billing.ts` 的 `creditCardBillingDayFromCycleEndDate`
 * 同口径），而账单原文写的是当月实际末日（28/29/30）。用它判断两边是不是同一天。
 */
function monthEndDay(ymd?: string | null) {
  const match = String(ymd ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
  // 纯日历计算，必须走 UTC，避免容器/浏览器时区把月末判成前一天。
  return day === new Date(Date.UTC(year, month, 0)).getUTCDate()
    ? CREDIT_CARD_MONTH_END_BILLING_DAY
    : day;
}

/** 月末口径的「同一天」：档案 31 与账单实际末日等价，不算误差。 */
function sameDayOfMonth(statementValue: number, accountValue: number, dateYmd?: string | null) {
  if (statementValue === accountValue) return true;
  return monthEndDay(dateYmd) === CREDIT_CARD_MONTH_END_BILLING_DAY
    && (statementValue === CREDIT_CARD_MONTH_END_BILLING_DAY || accountValue === CREDIT_CARD_MONTH_END_BILLING_DAY);
}

/**
 * 账单摘要 vs 账户档案（账单日/还款日/额度）。
 *
 * 只比双方都有值的字段：账本里没配（0/null）说明还没填过，导入时会补上，不算误差。
 * 额度按 1 分钱容差，避免 76000 与 76000.00 这种浮点噪声报错。
 */
export function compareCreditCardProfile(
  summary: CreditCardStatementSummary | null | undefined,
  account: CreditCardProfileSnapshot | null | undefined,
): CreditCardProfileMismatch[] {
  if (!summary || !account) return [];
  const mismatches: CreditCardProfileMismatch[] = [];
  const check = (
    field: CreditCardProfileMismatch["field"],
    statementValue: number | undefined | null,
    accountValue: number | undefined | null,
    options?: { tolerance?: number; dateYmd?: string | null; sameDay?: boolean },
  ) => {
    if (!Number.isFinite(statementValue) || !Number.isFinite(accountValue)) return;
    if ((statementValue as number) <= 0 || (accountValue as number) <= 0) return;
    if (options?.sameDay && sameDayOfMonth(statementValue as number, accountValue as number, options.dateYmd)) return;
    if (Math.abs((statementValue as number) - (accountValue as number)) <= (options?.tolerance ?? 0)) return;
    mismatches.push({ field, statementValue: statementValue as number, accountValue: accountValue as number });
  };
  check("billingDay", summary.billingDay, account.billingDay, { dateYmd: summary.statementPeriodEnd, sameDay: true });
  check("repaymentDay", summary.repaymentDay, account.repaymentDay, { dateYmd: summary.statementDueDate, sameDay: true });
  check("creditLimit", summary.creditLimit, account.creditLimit, { tolerance: 0.01 });
  return mismatches;
}
