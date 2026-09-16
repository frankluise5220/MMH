import type { IntervalUnit } from "@prisma/client";
import { formatDateUtc } from "@/lib/date-utils";
import { calcInitialScheduledRunDate, calcNextScheduledRunDate } from "@/lib/scheduled-task-date";
import { normalizeScheduledTaskType } from "@/lib/scheduled-task";

type TxRecordReader = {
  txRecord: {
    findFirst: (args: {
      where: {
        regularInvestPlanId: string;
        deletedAt: null;
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

export function getRegularInvestPlanRecordSources(taskType: string | null | undefined): string[] {
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
  const latestRecord = await db.txRecord.findFirst({
    where: {
      regularInvestPlanId: plan.id,
      deletedAt: null,
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
