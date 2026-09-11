export type BillingDayRuleInitialLike = {
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

export function isInitialBillingDayRule<T extends BillingDayRuleInitialLike>(
  rows: readonly T[],
  target: { id?: string | null; effectiveDate?: Date | string | number | null },
) {
  return markInitialBillingDayRules(rows).some((row) => {
    if (!row.isInitial) return false;
    if (target.id) return row.id === target.id;
    if (target.effectiveDate == null) return false;
    return timeOfDate(row.effectiveDate) === timeOfDate(target.effectiveDate);
  });
}
