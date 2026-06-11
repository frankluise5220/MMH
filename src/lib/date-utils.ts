export function startOfDayUtc(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function addDaysUtc(date: Date, days: number) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}

export function addMonthsUtc(date: Date, months: number) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

export function toStatementMonth(date: Date, billingDay: number) {
  const day = date.getUTCDate();
  const monthBase = day <= billingDay ? date : addMonthsUtc(date, 1);
  const y = monthBase.getUTCFullYear();
  const m = String(monthBase.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export function lastDayOfMonthUtc(y: number, m: number) {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

export function clampDay(y: number, m: number, day: number) {
  return Math.max(1, Math.min(day, lastDayOfMonthUtc(y, m)));
}

export function creditCardCycle(now: Date, billingDay: number, repaymentDay?: number | null) {
  const today = startOfDayUtc(now);
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();

  const thisEnd = new Date(Date.UTC(y, m, clampDay(y, m, billingDay)));
  const end =
    today.getTime() <= thisEnd.getTime()
      ? thisEnd
      : new Date(Date.UTC(y, m + 1, clampDay(y, m + 1, billingDay)));

  const prevEnd = new Date(
    Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, clampDay(end.getUTCFullYear(), end.getUTCMonth() - 1, billingDay)),
  );
  const start = addDaysUtc(prevEnd, 1);
  const nextEnd = addDaysUtc(end, 1);
  const isCurrentCycle = today.getTime() >= start.getTime() && today.getTime() < nextEnd.getTime();

  const due =
    repaymentDay && repaymentDay >= 1
      ? (() => {
          const dueMonthOffset = repaymentDay <= billingDay ? 1 : 0;
          const dueMonth = end.getUTCMonth() + dueMonthOffset;
          const dueYear = end.getUTCFullYear() + Math.floor(dueMonth / 12);
          const dueMonthNorm = ((dueMonth % 12) + 12) % 12;
          return new Date(Date.UTC(dueYear, dueMonthNorm, clampDay(dueYear, dueMonthNorm, repaymentDay)));
        })()
      : null;

  return { start, end, due, today, isCurrentCycle };
}

export function toNumber(value: unknown) {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && "toNumber" in value) {
    const v = value as { toNumber: () => number };
    return v.toNumber();
  }
  return Number(value ?? 0);
}

export function formatDateLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function formatDateUtc(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function addWorkdaysUtc(dateStr: string, n: number) {
  const [y, m, d] = dateStr.split("-").map(Number);
  let ms = Date.UTC(y, m - 1, d);
  let added = 0;
  while (added < n) {
    ms += 24 * 60 * 60 * 1000;
    const dow = new Date(ms).getUTCDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  const result = new Date(ms);
  const ry = result.getUTCFullYear();
  const rm = String(result.getUTCMonth() + 1).padStart(2, "0");
  const rd = String(result.getUTCDate()).padStart(2, "0");
  return `${ry}-${rm}-${rd}`;
}