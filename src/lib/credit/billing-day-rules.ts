import { isCreditCardMonthEndBillingDay } from "@/lib/credit/rules";
import { todayDateLocalYmd } from "@/lib/date-utils";

type BillingDayRuleInitialLike = {
  id?: string | null;
  effectiveDate: Date | string | number;
};

function timeOfDate(value: Date | string | number) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? Number.POSITIVE_INFINITY : date.getTime();
}

/**
 * The immutable initial billing-day rule is the earliest rule row, not every
 * row on the historical fallback date (1900-01-01). Older data can contain
 * multiple 1900-01-01 rows after institution-level mirroring/deduping; only the
 * first sorted row should stay locked.
 */
export function markInitialBillingDayRules<T extends BillingDayRuleInitialLike>(rows: readonly T[]) {
  let initialIndex = -1;
  let initialTime = Number.POSITIVE_INFINITY;
  rows.forEach((row, index) => {
    const time = timeOfDate(row.effectiveDate);
    if (time < initialTime) {
      initialTime = time;
      initialIndex = index;
    }
  });
  return rows.map((row, index) => ({ ...row, isInitial: index === initialIndex }));
}


export type CreditBillingDayRuleView = {
  id?: string;
  accountId?: string;
  effectiveDate: string;
  billingDay: number;
  /** 这条记录自带的固定还款日（1-31）；为空表示沿用账户级设置。 */
  repaymentDay?: number | null;
  /** 这条记录自带的「账单日后 N 天」；与 repaymentDay 互斥。 */
  repaymentOffsetDays?: number | null;
  isInitial: boolean;
};

export function billingDayRuleKey(rule: CreditBillingDayRuleView) {
  return rule.id || rule.effectiveDate;
}

/** 按生效日期取「当前」账单日（未来生效的规则不参与）；规则为空时回退基础值。 */
export function currentBillingDayFromRules(rules: readonly CreditBillingDayRuleView[], fallback: number | null) {
  const validRules = rules
    .filter((rule) => /^\d{4}-\d{2}-\d{2}$/.test(rule.effectiveDate) && Number.isInteger(rule.billingDay))
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
  if (validRules.length === 0) return fallback;

  // 这是纯函数，只在客户端组件里使用（账单日设置/汇总表），所以按用户本地日历取
  // 「今天」，不是部署时区；服务端的账单周期另有 businessTodayUtcStart(timeZone)。
  const today = todayDateLocalYmd();
  let active = validRules[0]!;
  for (const rule of validRules) {
    if (rule.effectiveDate > today) break;
    active = rule;
  }
  return active.billingDay;
}

/** 账单日的用户可见文案（含「月末」）。 */
export function billingDayDisplayValue(day: number, t: (key: string, params?: Record<string, string | number>) => string) {
  return isCreditCardMonthEndBillingDay(day)
    ? t("settings.accounts.billingDayMonthEndValue")
    : t("settings.accounts.billingDayValue", { day });
}
