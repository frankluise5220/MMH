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

import { formatDateLocal, toNumber } from "@/lib/date-utils";
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
};

function detailEntryDayKey(entry: RunningBalanceEntry, accountId: string) {
  return formatDateLocal(getDetailEntryDisplayDate(entry, accountId));
}

/** 入账日在今天之后的流水尚未发生：与服务端明细 SQL 口径一致，不改变余额。 */
function isFutureBalanceEntry(entry: RunningBalanceEntry, accountId: string) {
  return detailEntryDayKey(entry, accountId) > formatDateLocal(new Date());
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
) {
  if (isFutureBalanceEntry(entry, accountId)) return runningBalance;
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
) {
  if (isFutureBalanceEntry(entry, accountId)) return 0;
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
) {
  const ascEntries = [...entries].sort((a, b) => compareDetailEntriesAsc(a, b, accountId));
  const firstEntry = ascEntries[0];
  if (!firstEntry || firstEntry.runningBalance == null) return false;
  return Math.abs(toNumber(firstEntry.runningBalance) - runningBalanceContribution(firstEntry, accountId, accountKind)) < 0.005;
}

export function recalculateLoadedRunningBalances(
  entries: RunningBalanceEntry[],
  accountId: string,
  accountKind?: string | null,
): RunningBalanceEntry[] {
  const runningBalanceById = new Map<string, number>();
  let runningBalance = 0;
  for (const entry of [...entries].sort((a, b) => compareDetailEntriesAsc(a, b, accountId))) {
    runningBalance = applyEntryToRunningBalance(runningBalance, entry, accountId, accountKind);
    runningBalanceById.set(entry.id, runningBalance);
  }
  return entries.map((entry) => ({ ...entry, runningBalance: runningBalanceById.get(entry.id) ?? entry.runningBalance ?? null }));
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
): RunningBalanceDeleteResult<T> {
  const deletedEntries = entries.filter((entry) => deletedSet.has(entry.id));
  if (deletedEntries.length === 0) return { entries, complete: true };
  const remainingEntries = entries.filter((entry) => !deletedSet.has(entry.id));
  // ① 当前列表就是账户全部历史（起点可推导）时，从头整段重折叠：天然覆盖锚点，
  //    也覆盖「删的是锚点行」这种情况。
  if (canRecalculateRunningBalanceFromLoadedEntries(remainingEntries, accountId, accountKind)) {
    return { entries: recalculateLoadedRunningBalances(remainingEntries, accountId, accountKind) as T[], complete: true };
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
          accumulated += runningBalanceContribution(deleted, accountId, accountKind);
        }
      } else if (previousRemaining && previousRemaining.runningBalance != null) {
        const anchor = segment[anchorIndex]!;
        const target = getBalanceAnchorTarget(anchor)!;
        accumulated += target - toNumber(previousRemaining.runningBalance);
        for (let index = anchorIndex + 1; index < segment.length; index += 1) {
          accumulated += runningBalanceContribution(segment[index]!, accountId, accountKind);
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
