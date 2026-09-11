export const CREDIT_CARD_MONTH_END_BILLING_DAY = 31;
export const CREDIT_CARD_MAX_REPAYMENT_OFFSET_DAYS = 62;

export function isCreditCardMonthEndBillingDay(value: number | null | undefined) {
  return value === CREDIT_CARD_MONTH_END_BILLING_DAY;
}
