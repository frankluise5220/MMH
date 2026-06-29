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
  return addDaysUtc(date, weekday - adjustedCurrentDay);
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
  } else if ((unit === "week" || unit === "biweek") && executionDay != null && executionDay >= 1 && executionDay <= 5) {
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
  } else if ((unit === "week" || unit === "biweek") && executionDay != null && executionDay >= 1 && executionDay <= 5) {
    firstDate = dateAtWeekday(firstDate, executionDay);
    if (firstDate < startOfDayUtc(startDate)) firstDate = addWeeksUtc(firstDate, unit === "biweek" ? intervalValue * 2 : intervalValue);
  }

  return applyWeekendPolicy(firstDate, skipNonBusinessDays);
}
