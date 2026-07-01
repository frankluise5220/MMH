import type { IntervalUnit } from "@prisma/client";
import { addDaysUtc, lastDayOfMonthUtc, startOfDayUtc } from "@/lib/date-utils";

export function skipWeekend(date: Date): Date {
  let result = startOfDayUtc(date);
  while (result.getUTCDay() === 0 || result.getUTCDay() === 6) {
    result = addDaysUtc(result, 1);
  }
  return result;
}

function applyWeekendPolicy(date: Date, skipNonBusinessDays: boolean): Date {
  return skipNonBusinessDays ? skipWeekend(date) : date;
}

function dateAtMonthDay(date: Date, day: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const daysInMonth = lastDayOfMonthUtc(year, month);
  return new Date(Date.UTC(year, month, Math.min(day, daysInMonth)));
}

function dateAtWeekday(date: Date, weekday: number): Date {
  const currentDay = date.getUTCDay();
  const adjustedCurrentDay = currentDay === 0 ? 7 : currentDay;
  const normalizedWeekday = weekday === 0 ? 7 : weekday;
  return addDaysUtc(date, normalizedWeekday - adjustedCurrentDay);
}

function addWeeksUtc(date: Date, weeks: number): Date {
  return addDaysUtc(date, weeks * 7);
}

function addMonthsClampedUtc(date: Date, months: number): Date {
  const source = startOfDayUtc(date);
  const targetMonth = source.getUTCMonth() + months;
  const targetYear = source.getUTCFullYear() + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const day = Math.min(source.getUTCDate(), lastDayOfMonthUtc(targetYear, normalizedMonth));
  return new Date(Date.UTC(targetYear, normalizedMonth, day));
}

function addYearsClampedUtc(date: Date, years: number): Date {
  return addMonthsClampedUtc(date, years * 12);
}

export function isYearlyExecutionDay(value: number | null | undefined): value is number {
  if (value == null || !Number.isFinite(value)) return false;
  const month = Math.floor(value / 100);
  const day = value % 100;
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

export function encodeYearlyExecutionDay(value: string | Date): number | null {
  const date = value instanceof Date ? startOfDayUtc(value) : startOfDayUtc(new Date(value));
  if (!Number.isFinite(date.getTime())) return null;
  return (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
}

export function decodeYearlyExecutionDay(value: number | null | undefined, baseYear: number): Date | null {
  if (!isYearlyExecutionDay(value)) return null;
  const month = Math.floor(value / 100);
  const day = value % 100;
  const clampedDay = Math.min(day, lastDayOfMonthUtc(baseYear, month - 1));
  return new Date(Date.UTC(baseYear, month - 1, clampedDay));
}

function dateAtYearAnchor(date: Date, encodedMonthDay: number): Date {
  const anchor = decodeYearlyExecutionDay(encodedMonthDay, date.getUTCFullYear());
  return anchor ?? startOfDayUtc(date);
}

export function calcNextScheduledRunDate(
  fromDate: Date,
  unit: IntervalUnit,
  value: number,
  executionDay?: number | null,
  skipNonBusinessDays = true,
): Date {
  const intervalValue = Number.isFinite(value) && value > 0 ? value : 1;
  let nextDate: Date;

  if (unit === "month" && executionDay != null && executionDay >= 1 && executionDay <= 31) {
    nextDate = dateAtMonthDay(addMonthsClampedUtc(fromDate, intervalValue), executionDay);
  } else if (unit === "year" && isYearlyExecutionDay(executionDay)) {
    nextDate = dateAtYearAnchor(addYearsClampedUtc(fromDate, intervalValue), executionDay);
  } else if ((unit === "week" || unit === "biweek") && executionDay != null && executionDay >= 1 && executionDay <= 7) {
    nextDate = dateAtWeekday(addWeeksUtc(fromDate, unit === "biweek" ? intervalValue * 2 : intervalValue), executionDay);
  } else {
    switch (unit) {
      case "day":
        nextDate = addDaysUtc(fromDate, intervalValue);
        break;
      case "week":
        nextDate = addWeeksUtc(fromDate, intervalValue);
        break;
      case "biweek":
        nextDate = addWeeksUtc(fromDate, intervalValue * 2);
        break;
      case "month":
        nextDate = addMonthsClampedUtc(fromDate, intervalValue);
        break;
      case "year":
        nextDate = addYearsClampedUtc(fromDate, intervalValue);
        break;
      default:
        nextDate = addMonthsClampedUtc(fromDate, intervalValue);
        break;
    }
  }

  return applyWeekendPolicy(nextDate, skipNonBusinessDays);
}

export function calcInitialScheduledRunDate(
  startDate: Date,
  unit: IntervalUnit,
  value: number,
  executionDay?: number | null,
  skipNonBusinessDays = true,
): Date {
  const intervalValue = Number.isFinite(value) && value > 0 ? value : 1;
  let firstDate = startOfDayUtc(startDate);

  if (unit === "month" && executionDay != null && executionDay >= 1 && executionDay <= 31) {
    firstDate = dateAtMonthDay(firstDate, executionDay);
    if (firstDate < startOfDayUtc(startDate)) firstDate = dateAtMonthDay(addMonthsClampedUtc(firstDate, intervalValue), executionDay);
  } else if (unit === "year" && isYearlyExecutionDay(executionDay)) {
    firstDate = dateAtYearAnchor(firstDate, executionDay);
    if (firstDate < startOfDayUtc(startDate)) {
      firstDate = dateAtYearAnchor(addYearsClampedUtc(firstDate, intervalValue), executionDay);
    }
  } else if ((unit === "week" || unit === "biweek") && executionDay != null && executionDay >= 1 && executionDay <= 7) {
    firstDate = dateAtWeekday(firstDate, executionDay);
    if (firstDate < startOfDayUtc(startDate)) firstDate = addWeeksUtc(firstDate, unit === "biweek" ? intervalValue * 2 : intervalValue);
  }

  return applyWeekendPolicy(firstDate, skipNonBusinessDays);
}
