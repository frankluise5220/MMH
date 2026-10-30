/**
 * 基金导入预览的「净值异步回填」合并规则。
 *
 * 背景（用户 2026-10-30：明细要 1 秒内出来）：预览接口最多等 1.2 秒抓净值就先返回，
 * 抓不到的净值由后台继续补，前端隔几秒静默再问一次。回填必须**只补空值**，
 * 不能覆盖用户在预览里已经填/改过的内容。
 *
 * 规则（逐行，按数组下标对齐）：
 * - 当前行已有净值或份额 → 保留（可能是用户手填，也可能是上一轮回填填上的）；
 * - 当前行的代码 / 日期 / 金额与回填响应不一致 → 保留（用户改过，旧结果不再成立）；
 * - 否则用回填结果替换这一行。
 *
 * 泛型只要求用到的那几个字段，账单页与弹窗各自的本地行类型都能直接传进来。
 */
type NavBackfillRow = {
  fundCode?: string | null;
  date?: string | null;
  amount?: number | null;
  nav?: number | null;
  units?: number | null;
};

export function mergeNavBackfillRows<T extends NavBackfillRow>(
  previous: readonly T[],
  incoming: readonly T[],
): T[] {
  if (previous.length === 0) return [...incoming];
  const merged: T[] = [];
  for (let index = 0; index < incoming.length; index += 1) {
    const current = previous[index];
    const next = incoming[index];
    if (!next) {
      if (current) merged.push(current);
      continue;
    }
    if (!current) {
      merged.push(next);
      continue;
    }
    if (current.nav != null || current.units != null) {
      merged.push(current);
      continue;
    }
    if (current.fundCode !== next.fundCode || current.date !== next.date || current.amount !== next.amount) {
      merged.push(current);
      continue;
    }
    merged.push(next);
  }
  // 回填响应行数变少时（理论上不该发生）保留尾部，避免表格突然变短
  if (incoming.length < previous.length) merged.push(...previous.slice(incoming.length));
  return merged;
}

/** 预览接口返回「还有几行没净值」时，决定要不要排回填。 */
export function shouldBackfillNav(navMissingCount: number | undefined | null): boolean {
  return typeof navMissingCount === "number" && navMissingCount > 0;
}

/** 回填的两次延时（毫秒）：第一次尽早补上，第二次兜住慢接口。 */
export const NAV_BACKFILL_DELAYS_MS = [3_000, 9_000] as const;
