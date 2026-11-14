import { Prisma, RegularInvestStatus } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";

/**
 * 定期生息产品的公共编排件（存款 / 债券共用）。
 *
 * 这里只放**骨架**，不放口径：
 *   - 生息日的排期（depositPayoutAnchorUtc / bondPayoutDatesUpTo）由各业务模块决定；
 *   - 单期利息（depositSegmentInterest / estimateBondPeriodInterest）由各业务模块决定；
 *   - 结算写法（存款投影业务行、债券写 bond_transactions）由各业务模块注入。
 *
 * 共用的是那些「写了两遍就一定会漂移」的机械件：并发互斥、日键、取息的创建与
 * 余额重算、计划行收尾、manualOverride 分支。
 *
 * 反过来，凡是带业务口径的判断——付息日怎么步进、单期利息怎么算、什么算「已经取过」——
 * 一律留在各业务模块，不抽成参数、不做成开关。
 */

/** 一次生息/取息动作的统一返回形状（存款 depa_/depi_、债券 bonda_/bondi_ 共用）。 */
export type InterestAccrualResult = {
  status: "accrued" | "skipped";
  pairs?: number;
  totalInterest?: number;
  entryIds?: string[];
  reason?: string;
};

/**
 * 日历日键（YYYY-MM-DD）。
 *
 * 口径是 UTC：DB 的日历日字段存 UTC 零点，用本地 getter 会整体偏一天
 * （2026-09 存款付息因此反复补生成，见 autoAccruePeriodicInterest 的注释）。
 */
export function utcDayKey(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const singleFlight = new Map<string, Promise<unknown>>();
const exclusiveKeys = new Set<string>();

/**
 * 同一 key 并发时**复用进行中的 promise**（整批扫描入口用）。
 * 典型场景：页面刷新与开机自检同时触发到期扫描，第二次直接拿第一次的结果。
 */
export function runSingleFlight<T>(key: string, task: () => Promise<T>): Promise<T> {
  const running = singleFlight.get(key) as Promise<T> | undefined;
  if (running) return running;
  const promise = task().finally(() => {
    if (singleFlight.get(key) === promise) singleFlight.delete(key);
  });
  singleFlight.set(key, promise);
  return promise;
}

/**
 * 同一 key 已在执行时**立即返回 onBusy()**，不排队也不复用（单存单动作用）。
 *
 * 这里刻意不复用 promise：生息是按「计划行 + 存单」粒度调用的，并发的另一方
 * 往往正处在事务中途，等它既拿不到自己的统计量，也会把调用链拖成长事务。
 * 让调用方跳过、下一轮补跑，比排队更安全。
 */
export async function runExclusive<T>(key: string, task: () => Promise<T>, onBusy: () => T): Promise<T> {
  if (exclusiveKeys.has(key)) return onBusy();
  exclusiveKeys.add(key);
  try {
    return await task();
  } finally {
    exclusiveKeys.delete(key);
  }
}

export type InterestIncomeRow = { id: string; date: Date; amount: number; currency?: string | null };

/**
 * 取息动作的执行骨架：把调用方已经判定为「还没转出」的利息收入逐条转出，
 * 再重算两侧余额、汇总结果。
 *
 * 什么算「已经取过」是各条线自己的口径，判定留在各自文件：
 *   - 存款按「日 + 带符号金额」（转账金额本身是负数）；
 *   - 债券按「日 + 绝对值」。
 * 所以这里不接收键函数、也不再读一遍已存在的转账 —— 口径不进公共层。
 */
export async function createInterestTransfers(params: {
  /** 调用方已按自己的口径筛过的待转出利息。 */
  pending: InterestIncomeRow[];
  buildTransfer: (income: InterestIncomeRow, amount: number) => Prisma.TxRecordCreateManyInput;
  /** 转出后需要重算的账户（出账方 + 入账方）。 */
  recalcAccountIds?: Array<string | null | undefined>;
}): Promise<InterestAccrualResult> {
  const entryIds: string[] = [];
  let totalInterest = 0;

  for (const income of params.pending) {
    const amount = round2(Math.abs(Number(income.amount)));
    if (!(amount > 0)) continue;
    const transfer = await prisma.txRecord.create({ data: params.buildTransfer(income, amount) });
    entryIds.push(transfer.id);
    totalInterest = round2(totalInterest + amount);
  }

  if (entryIds.length === 0) return { status: "skipped", reason: "no pending interest" };

  for (const accountId of params.recalcAccountIds ?? []) {
    if (!accountId) continue;
    await recalcAndSaveAccountBalance(accountId).catch(() => {});
  }
  return { status: "accrued", pairs: entryIds.length, totalInterest, entryIds };
}

/**
 * 存单了结 / 被删除时结束该存单的系统计划行。
 *
 * 两边原本是两个函数，只差 id 前缀列表；现在前缀由调用方给，
 * 收尾语义（只在未完成时更新、失败不阻断业务）集中在这里。
 */
export async function completeSystemPlansForLot(params: {
  householdId: string;
  lotId: string;
  /** 该存单的系统计划 id 前缀，如 deposit 的 depm_/depa_/depi_。 */
  idPrefixes: string[];
}): Promise<void> {
  await prisma.regularInvestPlan
    .updateMany({
      where: {
        householdId: params.householdId,
        id: { in: params.idPrefixes.map((prefix) => `${prefix}${params.lotId}`) },
        status: { not: RegularInvestStatus.completed },
      },
      data: { status: RegularInvestStatus.completed },
    })
    .catch(() => {});
}

/**
 * 系统计划行的 upsert，统一 `manualOverride` 分支。
 *
 * 原本每个计划行都要写一遍 `manualOverride.has(id) ? {...} : {...}`，三处一份，
 * 改动时最容易只改一边。这里把「手动覆盖时只刷关联信息、不覆盖用户改过的
 * 周期/金额/下一执行日」这条规则收成一个地方。
 */
export async function upsertSystemPlan(params: {
  id: string;
  manualOverride: Set<string>;
  create: Prisma.RegularInvestPlanCreateManyInput & { id: string };
  /** 未被手动覆盖时：跟随存单条款刷新。 */
  autoUpdate: Prisma.RegularInvestPlanUncheckedUpdateInput;
  /** 手动覆盖时：只刷新关联信息，保留用户改过的字段。 */
  manualUpdate: Prisma.RegularInvestPlanUncheckedUpdateInput;
  /** 手动覆盖过也要推进下一执行日（存单付息后调用）。 */
  advanceManualNextRunDate?: boolean;
  manualNextRunDate?: Date | null;
}): Promise<{ id: string }> {
  const manual = params.manualOverride.has(params.id);
  const update = manual
    ? {
        ...params.manualUpdate,
        ...(params.advanceManualNextRunDate && params.manualNextRunDate
          ? { nextRunDate: params.manualNextRunDate }
          : {}),
      }
    : params.autoUpdate;
  return prisma.regularInvestPlan.upsert({
    where: { id: params.id },
    create: params.create,
    update,
    select: { id: true },
  });
}

function round2(value: number): number {
  return Number(Number(value).toFixed(2));
}
