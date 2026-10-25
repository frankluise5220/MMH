import { cache } from "react";
import { getHouseholdTimeZone } from "@/lib/server/household-preferences";
import { getHouseholdScope } from "@/lib/server/household-scope";

/**
 * 账簿的业务时区。服务端所有「今天 / 本月 / 本年」都必须经过这里，
 * 而不是 `MMH_TIME_ZONE`：后者只是部署默认值，用户改了设置页却不生效
 * 正是历史 bug 的来源。
 *
 * `householdId` 缺失（系统任务、跨账簿批处理）时才回落到部署默认值——
 * 该回落逻辑在 `getHouseholdTimeZone` 里，保持单一实现。
 */
export async function resolveHouseholdTimeZone(householdId?: string | null): Promise<string> {
  return getHouseholdTimeZone(householdId);
}

/**
 * 当前请求所属账簿的时区。RSC 页面 / API route 等有请求上下文的地方直接用它。
 *
 * `cache()` 保证同一次请求只查一次库。
 */
export const getRequestTimeZone = cache(async (): Promise<string> => {
  const { householdId } = await getHouseholdScope();
  return resolveHouseholdTimeZone(householdId);
});
