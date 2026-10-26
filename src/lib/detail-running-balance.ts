/**
 * 明细「余额」列（每行事后余额 runningBalance）的客户端重算口径。
 *
 * 设计约束（务必遵守）：
 * - 值不落库，由服务端明细 SQL 累加得出；客户端只做**当前已渲染页行数**的
 *   本地算术，绝不查库、绝不发请求、绝不触发全量重算（历史上几万条的重算会卡）。
 * - 校准口径必须严格一致：期初余额 / 余额校准（下称「锚点」）把余额钉成 target，
 *   它之前的流水影响不到它之后的行；锚点行自己被删时，其后所有行整体平移一个
 *   常量（锚点前一条未删行的余额 − target）。
 *
 * 单独成文件（而不是放在 DetailViewClient 里）是为了能脱离 React 直接用
 * `tsx scripts/verify-detail-running-balance-recalc.ts` 做口径校验。
 */

import { formatDateUtc, toNumber, todayDateBusinessYmd } from "@/lib/date-utils";
import { applyBalanceAnchorEntry, getBalanceAnchorTarget } from "@/lib/balance-reconcile";
import { compareDetailEntriesAsc, getDetailEntryDisplayDate } from "@/lib/detail-entry-order";
import { liabilityPrincipalForAccountSide } from "@/lib/liability";

/** DetailEntry 的结构子集：只要满足这些字段就能参与余额重算。 */
export type RunningBalanceEntry = {
  id: string;
  date: string;
  postedAt?: string | null;
  createdAt?: string | null;
  dayOrder?: number | null;
  amount: number;
  runningBalance?: number | null;
  type: string;
  accountId?: string | null;
  toAccountId?: string | null;
  toNote?: string | null;
  source?: string | null;
  fundSubtype?: string | null;
  fundProductType?: string | null;
  fundConfirmDate?: string | null;
  fundArrivalDate?: string | null;
  principalAmount?: number | null;
  fundArrivalAmount?: number | null;
  /** 对账锁定钉住的本行事后余额；非空即该行是锚点（等价「余额校准」）。 */
  reconciledBalance?: number | null;
};

function detailEntryDayKey(entry: RunningBalanceEntry, accountId: string) {
  // DB 日历日字段是 UTC 零点，必须用 UTC 格式化；本地 getter 会随进程/浏览器时区漂移。
  return formatDateUtc(getDetailEntryDisplayDate(entry, accountId));
}

/**
 * 入账日在今天之后的流水尚未发生：与服务端明细 SQL 口径一致，不改变余额。
 * 「今天」必须用业务时区（服务端 SQL 用 `todayDateBusinessYmd`），
 * 不能用浏览器本地日期，否则余额列与列表可见性会在跨时区/凌晨时分叉。
 */
function isFutureBalanceEntry(entry: RunningBalanceEntry, accountId: string, todayKey: string) {
  return detailEntryDayKey(entry, accountId) > todayKey;
}

/** 贷款 / 往来款账户：只有 transfer 腿参与，本金带 source 决定的正负号（与 foldBalanceEntry 一致）。 */
export function isLiabilityBalanceAccountKind(accountKind?: string | null) {
  return accountKind === "loan" || accountKind === "settlement";
}

export function applyEntryToRunningBalance(
  runningBalance: number,
  entry: RunningBalanceEntry,
  accountId: string,
  accountKind?: string | null,
  todayKey: string = todayDateBusinessYmd(),
) {
  if (isFutureBalanceEntry(entry, accountId, todayKey)) return runningBalance;
  if (isLiabilityBalanceAccountKind(accountKind)) {
    if (getBalanceAnchorTarget(entry) != null) return applyBalanceAnchorEntry(runningBalance, entry, accountId);
    if (entry.type !== "transfer") return runningBalance;
    return runningBalance + liabilityPrincipalForAccountSide(entry, accountId);
  }
  return applyBalanceAnchorEntry(runningBalance, entry, accountId);
}

export function runningBalanceContribution(
  entry: RunningBalanceEntry,
  accountId: string,
  accountKind?: string | null,
  todayKey: string = todayDateBusinessYmd(),
) {
  if (isFutureBalanceEntry(entry, accountId, todayKey)) return 0;
  if (isLiabilityBalanceAccountKind(accountKind)) {
    if (getBalanceAnchorTarget(entry) != null) return applyBalanceAnchorEntry(0, entry, accountId);
    return entry.type === "transfer" ? liabilityPrincipalForAccountSide(entry, accountId) : 0;
  }
  return applyBalanceAnchorEntry(0, entry, accountId);
}

export function canRecalculateRunningBalanceFromLoadedEntries(
  entries: RunningBalanceEntry[],
  accountId: string,
  accountKind?: string | null,
  todayKey: string = todayDateBusinessYmd(),
) {
  const ascEntries = [...entries].sort((a, b) => compareDetailEntriesAsc(a, b, accountId));
  const firstEntry = ascEntries[0];
  if (!firstEntry || firstEntry.runningBalance == null) return false;
  return Math.abs(toNumber(firstEntry.runningBalance) - runningBalanceContribution(firstEntry, accountId, accountKind, todayKey)) < 0.005;
}

export function recalculateLoadedRunningBalances(
  entries: RunningBalanceEntry[],
  accountId: string,
  accountKind?: string | null,
  todayKey: string = todayDateBusinessYmd(),
): RunningBalanceEntry[] {
  const runningBalanceById = new Map<string, number>();
  let runningBalance = 0;
  for (const entry of [...entries].sort((a, b) => compareDetailEntriesAsc(a, b, accountId))) {
    runningBalance = applyEntryToRunningBalance(runningBalance, entry, accountId, accountKind, todayKey);
    runningBalanceById.set(entry.id, runningBalance);
  }
  return entries.map((entry) => ({ ...entry, runningBalance: runningBalanceById.get(entry.id) ?? entry.runningBalance ?? null }));
}

/**
 * 按调用方给的顺序（服务端顺序：新 → 旧）折叠出每行的余额。
 *
 * 与服务端 `balanced` CTE 等价：锚点行把余额钉到目标值并重新开始累加，
 * 锚点之前的行不影响之后（见 `applyBalanceAnchorEntry`）。
 *
 * 不能复用 `recalculateLoadedRunningBalances`：那个会先用客户端的
 * `compareDetailEntriesAsc` 重排，而明细顺序必须与 SQL 的
 * `dayKey DESC, isAnchor DESC, dayOrder DESC, displayAt DESC, createdAt DESC, id DESC`
 * 逐键一致；只要同一天有多行、客户端少一个次级键，整段余额就会错开
 * （实测同一账户 2064 行里会有 99 行对不上，最大差 2 万多）。
 *
 * 现在的用法是：一行数据只在「全部收支」缓存里存一份，单账户视图按
 * accountId/toAccountId 筛出来，顺序天然是那份缓存（服务端已排好）的子序列，
 * 再在这里补余额——所以顺序必须是**传进来的顺序**，不能重排。
 */
export function foldRunningBalancesInDescOrder<T extends RunningBalanceEntry>(
  entries: readonly T[],
  accountId: string,
  accountKind?: string | null,
  todayKey: string = todayDateBusinessYmd(),
): T[] {
  const runningBalanceById = new Map<string, number>();
  let runningBalance = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) continue;
    runningBalance = applyEntryToRunningBalance(runningBalance, entry, accountId, accountKind, todayKey);
    runningBalanceById.set(entry.id, runningBalance);
  }
  return entries.map((entry) => ({
    ...entry,
    runningBalance: runningBalanceById.get(entry.id) ?? entry.runningBalance ?? null,
  }));
}

export type RunningBalanceDeleteResult<T extends RunningBalanceEntry = RunningBalanceEntry> = {
  entries: T[];
  /**
   * false = 本地推导不出（被删的锚点行之前没有任何已加载行，拿不到它之前的
   * 余额基准）。此时 entries 里的 runningBalance 仍是删除前的旧值，调用方应
   * 按当前页重取一次；true = 已就地算对，无需任何请求。
   */
  complete: boolean;
};

/**
 * 删除若干条流水后重算剩余行的「余额」列。
 *
 * 导出给 BasicDetailPanel 用：父层负责从 localEntries 里剔除已删行，而
 * DetailViewClient 只要发现 initialEntries 换了引用就会丢弃自己的
 * refreshedEntries 快照。所以父层必须在剔除的同时把重算后的 runningBalance
 * 一起写进新的 initialEntries，否则子组件算好的余额会被立刻清掉，列表只剩
 * 「行少了、后续余额没变」，必须刷新才正确。
 */
export function removeEntriesAndUpdateRunningBalances<T extends RunningBalanceEntry>(
  entries: T[],
  deletedSet: Set<string>,
  accountId: string,
  accountKind?: string | null,
  todayKey: string = todayDateBusinessYmd(),
): RunningBalanceDeleteResult<T> {
  const deletedEntries = entries.filter((entry) => deletedSet.has(entry.id));
  if (deletedEntries.length === 0) return { entries, complete: true };
  const remainingEntries = entries.filter((entry) => !deletedSet.has(entry.id));
  // ① 当前列表就是账户全部历史（起点可推导）时，从头整段重折叠：天然覆盖锚点，
  //    也覆盖「删的是锚点行」这种情况。
  if (canRecalculateRunningBalanceFromLoadedEntries(remainingEntries, accountId, accountKind, todayKey)) {
    return { entries: recalculateLoadedRunningBalances(remainingEntries, accountId, accountKind, todayKey) as T[], complete: true };
  }

  // ②③ 增量修正：O(当前页行数) 的本地算术。
  //   记 acc_i = 删除前余额 − 删除后余额，沿 ASC 顺序累加：
  //   - 段内无被删锚点：acc += Σ 该段被删行贡献额；
  //   - 段内有被删锚点：只认**最后一个**锚点 A，
  //     acc += (target_A − 上一条未删行的余额) + Σ(A 之后、本行之前) 的被删行
  //     贡献额——A 之前的被删行被 A 钉死，不计入；
  //   - 当前行本身是未删锚点：它的余额恒为 target（acc 归零），并截断累积，
  //     使之前删行的影响不越过校准点。
  const deletedAsc = [...deletedEntries].sort((a, b) => compareDetailEntriesAsc(a, b, accountId));
  const remainingAsc = [...remainingEntries].sort((a, b) => compareDetailEntriesAsc(a, b, accountId));
  const adjustmentById = new Map<string, number>();
  let accumulated = 0;
  let cursor = 0;
  let previousRemaining: RunningBalanceEntry | null = null;
  let complete = true;

  for (const entry of remainingAsc) {
    const segment: RunningBalanceEntry[] = [];
    while (cursor < deletedAsc.length) {
      const deleted = deletedAsc[cursor];
      if (!deleted || compareDetailEntriesAsc(deleted, entry, accountId) >= 0) break;
      segment.push(deleted);
      cursor += 1;
    }
    if (segment.length > 0) {
      let anchorIndex = -1;
      for (let index = segment.length - 1; index >= 0; index -= 1) {
        if (getBalanceAnchorTarget(segment[index]!) != null) {
          anchorIndex = index;
          break;
        }
      }
      if (anchorIndex < 0) {
        for (const deleted of segment) {
          accumulated += runningBalanceContribution(deleted, accountId, accountKind, todayKey);
        }
      } else if (previousRemaining && previousRemaining.runningBalance != null) {
        const anchor = segment[anchorIndex]!;
        const target = getBalanceAnchorTarget(anchor)!;
        accumulated += target - toNumber(previousRemaining.runningBalance);
        for (let index = anchorIndex + 1; index < segment.length; index += 1) {
          accumulated += runningBalanceContribution(segment[index]!, accountId, accountKind, todayKey);
        }
      } else {
        // 被删的锚点行之前没有任何已加载行：拿不到它之前的余额基准，只能交回
        // 上层按当前页重取（绝不触发全量重算）。
        complete = false;
        break;
      }
    }

    if (getBalanceAnchorTarget(entry) != null) {
      // 锚点行的余额恒等于 target，不受任何删行影响，同时截断累积。
      adjustmentById.set(entry.id, 0);
      accumulated = 0;
    } else {
      adjustmentById.set(entry.id, accumulated);
    }
    previousRemaining = entry;
  }

  if (!complete) return { entries: remainingEntries, complete: false };
  return {
    entries: remainingEntries.map((entry) => {
      if (entry.runningBalance == null) return entry;
      const adjustment = adjustmentById.get(entry.id) ?? 0;
      return adjustment === 0
        ? entry
        : { ...entry, runningBalance: toNumber(entry.runningBalance) - adjustment };
    }) as T[],
    complete: true,
  };
}
