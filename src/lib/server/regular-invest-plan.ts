import type { IntervalUnit } from "@prisma/client";
import { formatDateUtc } from "@/lib/date-utils";
import { calcInitialScheduledRunDate, calcNextScheduledRunDate } from "@/lib/scheduled-task-date";
import { normalizeScheduledTaskType } from "@/lib/scheduled-task";

type TxRecordReader = {
  txRecord: {
    findFirst: (args: {
      where: {
        regularInvestPlanId: string;
        householdId?: string;
        source: { in: string[] };
      };
      orderBy: Array<{ date: "desc" } | { createdAt: "desc" }>;
      select: { date: true };
    }) => Promise<{ date: Date } | null>;
  };
};

type RegularInvestPlanSchedule = {
  id: string;
  householdId?: string | null;
  taskType?: string | null;
  startDate: Date;
  lastRunDate?: Date | null;
  intervalUnit: IntervalUnit;
  intervalValue: number;
  executionDay?: number | null;
  secondaryExecutionDay?: number | null;
};

function getRegularInvestPlanRecordSources(taskType: string | null | undefined): string[] {
  const normalizedTaskType = normalizeScheduledTaskType(taskType);
  if (normalizedTaskType === "fund_regular_invest") return ["regular_invest"];
  if (normalizedTaskType === "insurance_premium") return ["insurance"];
  return ["scheduled_task"];
}

type FundNavDateRows = Array<{ fundCode: string; _max: { navDate: Date | null } }>;

/**
 * 汇总各基金在本地净值缓存里已公布到的最新净值日（YYYY-MM-DD）。
 * 用于区分「该确认日没有净值」与「该确认日的净值还没公布」，见 isConfirmedNavGap。
 */
export function buildLatestNavDateMap(rows: FundNavDateRows): Map<string, string> {
  const latestByCode = new Map<string, string>();
  for (const row of rows) {
    if (!row._max.navDate) continue;
    const value = formatDateUtc(row._max.navDate);
    const current = latestByCode.get(row.fundCode);
    if (!current || value > current) latestByCode.set(row.fundCode, value);
  }
  return latestByCode;
}

/**
 * 判断某个「确认日查不到净值」的日期是否属于**确定无净值**（非交易日 / 临时停售），
 * 即是否应当跳过且不再补记。
 *
 * 判定依据是该基金已公布的净值序列有没有**越过**该确认日：序列已经走到更晚的日期却
 * 仍然没有这一天的数据 → 这天确实没有净值（市场休市等），可以跳过；否则说明净值只是
 * 还没公布，应当照常生成记录（净值/份额留空，之后由 /api/v1/fund/refresh-pending 回填）。
 *
 * 背景（2026-09-14 实修）：原实现只按「确认日是否已过今天」判定，把「净值尚未公布」
 * 误判成「该日无净值」并永久跳过；而批量补记的起始日是「最后一条已有记录的下一天」、
 * 自动执行会把 nextRunDate 直接推过该日，因此被跳过的日期永远不会补回来。
 * 实例：021778（广发纳指100ETF联接QDII）美股 QDII 净值晚一个交易日披露、又撞周末，
 * 2026-09-11 的净值在 09-14 中午仍未公布，09-11 的定投记录就被永久漏掉。
 * 缓存里完全没有该基金净值序列时（null）保守处理为「不算真空洞」，宁可生成待确认记录。
 */
export function isConfirmedNavGap(params: {
  confirmDateStr: string;
  latestNavDateStr: string | null | undefined;
}): boolean {
  const latestNavDateStr = params.latestNavDateStr;
  if (!latestNavDateStr) return false;
  return params.confirmDateStr <= latestNavDateStr;
}

export async function deriveRegularInvestNextRunDate(
  db: TxRecordReader,
  plan: RegularInvestPlanSchedule,
): Promise<Date> {
  const normalizedTaskType = normalizeScheduledTaskType(plan.taskType);
  // 不看 deletedAt：用户删掉的那一期是「墓碑」，仍然算该计划已经走到过的日期。
  // 否则删掉最新一期再改计划设置，游标会退回被删的期次，下一轮执行又把它造回来。
  const latestRecord = await db.txRecord.findFirst({
    where: {
      regularInvestPlanId: plan.id,
      ...(plan.householdId ? { householdId: plan.householdId } : {}),
      source: { in: getRegularInvestPlanRecordSources(normalizedTaskType) },
    },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    select: { date: true },
  });

  const usesBusinessDays = normalizedTaskType === "fund_regular_invest";
  const cursorDate = latestRecord?.date ?? plan.lastRunDate ?? null;
  if (cursorDate) {
    return calcNextScheduledRunDate(
      cursorDate,
      plan.intervalUnit,
      plan.intervalValue,
      plan.executionDay,
      usesBusinessDays,
      plan.secondaryExecutionDay,
    );
  }

  return calcInitialScheduledRunDate(
    plan.startDate,
    plan.intervalUnit,
    plan.intervalValue,
    plan.executionDay,
    usesBusinessDays,
    plan.secondaryExecutionDay,
  );
}

/**
 * 基金定投「批量执行/补记」的起点与去重口径。
 *
 * 起点 = 计划的「下个执行日」（`nextRunDate`）——它是用户唯一能手动拨动的游标：
 * 拨到过去某天，就是要求从那天开始补记（确认框承诺「生成所有到期但未执行的明细」）；
 * 拨到未来，就是不生成中间期次。此前起点一律取「最近一笔记录 + 一个周期」，
 * 于是把下个执行日回拨到 10-30 后再点执行，只按最近记录补出今天这一期，
 * 10-30 ~ 昨天 的期次永久缺失，用户改了「下个执行日」却看不到任何效果。
 *
 * 去重：已生成过的日期不重复生成。被用户删掉的期次默认也是「墓碑」，
 * 但用户把游标拨到「最近一次执行 + 一个周期」之前时，就是显式要求重做那段历史 ——
 * 此时「早于上次执行日期」的墓碑不再拦截（仍然有效的记录照旧跳），
 * 否则「先删旧期次、再回拨游标、然后执行」会一条都生不出来；
 * 而「刚刚删掉最近一期」的墓碑仍在保护范围内，不会被下一轮补记造回来。
 */
export type FundBatchExecuteCursor = {
  /** 本轮开始生成的日期 */
  startDate: Date;
  /**
   * 逐日去重：该日期是否已经「有记录」而应当跳过。
   * 有效记录永远跳；墓碑（被删掉的期次）只有在游标被显式回拨、
   * 且该期次早于「上次执行日期」时才允许重做。
   */
  isBlocked: (dateKey: string, date: Date) => boolean;
  /** 用户是否把游标显式拨回到「上次执行 + 一个周期」之前 */
  cursorMovedBack: boolean;
};

export function resolveFundBatchExecuteCursor(params: {
  nextRunDate?: Date | null;
  lastRunDate?: Date | null;
  /** 计划行上已存在的最晚记录日期（含已删除的墓碑） */
  latestRecordDate?: Date | null;
  startDate: Date;
  intervalUnit: IntervalUnit;
  intervalValue: number;
  executionDay?: number | null;
  secondaryExecutionDay?: number | null;
  /** 已生成过的所有日期（含墓碑） */
  existingDates: Set<string>;
  /** 仍然有效的记录日期（不含墓碑） */
  liveDates: Set<string>;
}): FundBatchExecuteCursor {
  const nextRunFrom = (from: Date) =>
    calcNextScheduledRunDate(
      from,
      params.intervalUnit,
      params.intervalValue,
      params.executionDay,
      true,
      params.secondaryExecutionDay,
    );

  const derivedNextRunDate = params.lastRunDate ? nextRunFrom(params.lastRunDate) : null;
  const cursorMovedBack =
    !!params.nextRunDate && !!derivedNextRunDate && params.nextRunDate.getTime() < derivedNextRunDate.getTime();
  // 允许重做墓碑的日期界线：只有「回拨游标 + 早于上次执行日期」的期次算显式重做。
  // 上次执行日期及其之后的墓碑照旧拦着 —— 用户刚刚删掉最近一期时，
  // 下一轮补记不能把它又造回来。
  const replayBefore = cursorMovedBack && params.lastRunDate ? params.lastRunDate : null;
  const isBlocked = (dateKey: string, date: Date) => {
    if (!params.existingDates.has(dateKey)) return false;
    if (params.liveDates.has(dateKey)) return true;
    if (replayBefore && date.getTime() < replayBefore.getTime()) return false;
    return true;
  };

  let startDate: Date;
  if (params.nextRunDate) {
    startDate = params.nextRunDate;
  } else if (params.latestRecordDate) {
    startDate = nextRunFrom(params.latestRecordDate);
  } else if (params.lastRunDate) {
    // 记录被全部删除（连墓碑都没有）：计划游标证明历史期次已经执行过，从游标之后继续
    startDate = nextRunFrom(params.lastRunDate);
  } else {
    startDate = calcInitialScheduledRunDate(
      params.startDate,
      params.intervalUnit,
      params.intervalValue,
      params.executionDay,
      true,
      params.secondaryExecutionDay,
    );
  }

  return { startDate, isBlocked, cursorMovedBack };
}
