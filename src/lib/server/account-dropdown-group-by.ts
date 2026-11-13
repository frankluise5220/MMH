// 服务端读取「账户下拉分组维度」设置（2026-11-13）。
// cookie 名与 `src/lib/client/appPreferences.ts` 的 `ACCOUNT_DROPDOWN_GROUP_BY_KEY`
// 保持一致；那个模块是 client-only，所以这里重复写一遍字面量
// （与 `src/lib/server/account-label-fields.ts` 同一套做法）。
import { cookies } from "next/headers";

import { normalizeAccountDropdownGroupBy, type AccountDropdownGroupBy } from "@/lib/preferences";

export const ACCOUNT_DROPDOWN_GROUP_BY_COOKIE = "account_dropdown_group_by";

export function accountDropdownGroupByFromCookieValue(value: string | undefined): AccountDropdownGroupBy {
  return normalizeAccountDropdownGroupBy(value);
}

export async function getServerAccountDropdownGroupBy(): Promise<AccountDropdownGroupBy> {
  const store = await cookies();
  return accountDropdownGroupByFromCookieValue(store.get(ACCOUNT_DROPDOWN_GROUP_BY_COOKIE)?.value);
}
