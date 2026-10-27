import { cache } from "react";
import { serializeAccountLabelFields } from "@/lib/account-display";
import { resolveBusinessTimeZone } from "@/lib/date-utils";
import { prisma } from "@/lib/db/prisma";
import {
  preferencesFromRow,
  type AppPreferences,
  type PreferenceRow,
} from "@/lib/preferences";

/**
 * 读取账簿设置。没有记录时返回默认值，**不**顺手 insert——
 * GET 请求不该写库，否则每次首屏都会多一次无意义写入。
 */
export const getHouseholdPreferences = cache(async (householdId: string): Promise<AppPreferences> => {
  const row = await prisma.householdPreference.findUnique({ where: { householdId } });
  return preferencesFromRow(row as PreferenceRow | null);
});

/**
 * 只取时区，供服务端「今天/本月/本年」与时刻格式化使用。
 *
 * 没有账簿上下文（后台批量任务）时回落到部署默认值，所以调用方可以放心传
 * `hidFilter?.householdId`。业务代码优先用 `resolveHouseholdTimeZone()`，
 * 两者语义完全相同。
 */
export async function getHouseholdTimeZone(householdId?: string | null): Promise<string> {
  if (!householdId) return resolveBusinessTimeZone();
  return (await getHouseholdPreferences(householdId)).timeZone;
}

/**
 * `AppPreferences` → 行数据（写库用）。
 *
 * 备份恢复（`backup.ts`）复用同一份映射：两处各写一遍字段清单，
 * 迟早会漏一个，而漏字段不会报错、只会静默落回列默认值。
 */
export function preferenceRowData(prefs: AppPreferences) {
  return {
    sessionDays: prefs.sessionDays,
    fundUnitsDecimals: prefs.fundUnitsDecimals,
    aiPanelEnabled: prefs.aiPanelEnabled,
    timeZone: prefs.timeZone,
    colorScheme: prefs.colorScheme,
    creditCardLabelMode: prefs.creditCardLabelMode,
    creditCardLabelTemplate: prefs.creditCardLabelTemplate,
    creditCardSidebarLabelTemplate: prefs.creditCardSidebarLabelTemplate,
    creditBillHideZero: prefs.creditBillHideZero,
    creditBillHideSettled: prefs.creditBillHideSettled,
    creditBillShowRecentCycles: prefs.creditBillShowRecentCycles,
    displayLanguage: prefs.displayLanguage,
    dateDisplayFormat: prefs.dateDisplayFormat,
    sidebarGroupBy: prefs.sidebarGroupBy,
    sidebarHideZero: prefs.sidebarHideZero,
    sidebarHideInitialData: prefs.sidebarHideInitialData,
    sidebarShowFixedAssets: prefs.sidebarShowFixedAssets,
    sidebarShowAllCashEntries: prefs.sidebarShowAllCashEntries,
    sidebarShowReimbursements: prefs.sidebarShowReimbursements,
    detailDateBackground: prefs.detailDateBackground,
    detailWindowYears: prefs.detailWindowYears,
    rowHeightMode: prefs.rowHeightMode,
    accountLabelFields: serializeAccountLabelFields(prefs.accountLabelFields),
    accountDropdownRestrictType: prefs.accountDropdownRestrictType,
    accountUsageSortEnabled: prefs.accountUsageSortEnabled,
  };
}

/** 局部更新。未传的字段保持库中原值（没有行时用默认值补齐）。 */
export async function updateHouseholdPreferences(
  householdId: string,
  patch: Partial<AppPreferences>,
): Promise<AppPreferences> {
  const current = await getHouseholdPreferences(householdId);
  const next: AppPreferences = { ...current, ...patch };
  const data = preferenceRowData(next);

  const row = await prisma.householdPreference.upsert({
    where: { householdId },
    create: { householdId, ...data },
    update: data,
  });
  return preferencesFromRow(row as PreferenceRow);
}
