import { FundSubtype, RegularInvestStatus } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { addDaysUtc, formatDateUtc, startOfDayUtc, toNumber } from "@/lib/date-utils";
import {
  decodeScheduledTaskMemo,
  normalizeScheduledTaskType,
  scheduledTaskTypeLabel,
  type ScheduledTaskPayload,
} from "@/lib/scheduled-task";
import {
  isManualConfirmReminderKind,
  isUpcomingReminderKind,
  reminderUrgency,
  type ExecutionReceipt,
  type ReminderItem,
  type ReminderKind,
} from "@/lib/notifications";

/**
 * 通知栏的服务端取数：一次查库同时产出
 *   1. reminders —— 未来 7 天内到期（含最近逾期）的存单/债券/保险/贷款/转账计划；
 *   2. receipt   —— 系统**真实落账**的执行回执（读 TxRecord，不看 ok:true）。
 *
 * 之所以把回执放在服务端：客户端 toast 只在"这次浏览器自己触发了执行"时存在，
 * 刷新即丢；而"系统到底执行了没有"必须能跨设备、跨刷新回答。真源只有一条——
 * 带 regularInvestPlanId 的 TxRecord 行。
 */

/** 提醒窗口：今天起 7 天内到期。 */
export const REMINDER_WINDOW_DAYS = 7;
/**
 * 逾期回溯上限。自动执行类计划逾期 = 系统本该落账却没落账，是最需要暴露的信号；
 * 但也不能无限回溯，否则长期卡住的僵尸计划会永久霸占面板。
 */
export const REMINDER_OVERDUE_DAYS = 30;
/** 回执统计窗口（天）。 */
export const RECEIPT_WINDOW_DAYS = 7;
/**
 * 同一批执行写在同一个事务里，createdAt 几乎相同。用分钟级窗口把"最近一次执行"
 * 从流水里切出来，避免把整周的执行都算成"刚刚"。
 */
const LAST_BATCH_WINDOW_MS = 5 * 60 * 1000;

export type NotificationFeed = {
  reminders: ReminderItem[];
  receipt: ExecutionReceipt;
  /** 逾期未落账的**自动**计划数（手工确认类不计入）。 */
  overdueAutoCount: number;
};

/**
 * 计划类型 → 提醒类型。返回 null 表示这类计划不进提醒：只有内部记账（生息）
 * 不进 —— 它不是用户事件。日常定投/固定收支要进，但只在**逾期**时展示
 * （未来日期天天都有，见 UPCOMING_REMINDER_KINDS）。
 */
function reminderKindOf(taskType: unknown): ReminderKind | null {
  switch (normalizeScheduledTaskType(taskType)) {
    case "fund_regular_invest":
      return "fund_regular_invest";
    case "deposit_maturity":
      return "deposit_maturity";
    case "deposit_interest_payout":
      return "deposit_interest_payout";
    case "bond_maturity":
      return "bond_maturity";
    case "bond_interest_payout":
      return "bond_interest_payout";
    case "insurance_premium":
      return "insurance_premium";
    case "loan_repayment":
      return "loan_repayment";
    case "transfer":
      return "transfer";
    case "income":
      return "income";
    case "expense":
      return "expense";
    default:
      return null;
  }
}

function diffDaysUtc(from: Date, to: Date) {
  return Math.round((startOfDayUtc(to).getTime() - startOfDayUtc(from).getTime()) / 86_400_000);
}

type PlanRow = {
  id: string;
  fundName: string | null;
  planName: string | null;
  targetName: string | null;
  insuranceProductName: string | null;
  memo: string | null;
  taskType: string | null;
  amount: unknown;
  nextRunDate: Date;
  status: RegularInvestStatus;
};

/**
 * 存款/债券计划的展示名。计划行自身的 fundName 对存款是泛称「存款」、对债券是
 * fundCode 占位，只有回到存单才能拿到「XX银行3年期」「XX债 #2」。
 * 口径与 regular-invest/page.tsx 的 systemPlanSourceByPlanId **完全一致**：
 * 存款取 TxRecord.fundName（lot = memo.depositSourceEntryId 或 depm_/depi_ 前缀），
 * 债券取 BondProduct.name ?? productName，同债单多张存单按起息日加「#序号」。
 */
async function loadPlanLotNames(params: {
  householdId: string;
  plans: PlanRow[];
  taskByPlanId: Map<string, ScheduledTaskPayload>;
}): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const depositLotIdByPlanId = new Map<string, string>();
  const bondLotIdByPlanId = new Map<string, string>();

  for (const plan of params.plans) {
    const task = params.taskByPlanId.get(plan.id);
    if (!task) continue;
    if (task.type === "deposit_maturity" || task.type === "deposit_interest_payout") {
      const lotId =
        task.depositSourceEntryId ||
        (plan.id.startsWith("depm_") || plan.id.startsWith("depi_") ? plan.id.slice(5) : "");
      if (lotId) depositLotIdByPlanId.set(plan.id, lotId);
    } else if (task.type === "bond_maturity" || task.type === "bond_interest_payout") {
      const lotId = plan.id.startsWith("bondm_") || plan.id.startsWith("bondi_") ? plan.id.slice(6) : "";
      if (lotId) bondLotIdByPlanId.set(plan.id, lotId);
    }
  }

  if (depositLotIdByPlanId.size > 0) {
    const lots = await prisma.txRecord.findMany({
      where: { id: { in: [...new Set(depositLotIdByPlanId.values())] }, deletedAt: null },
      select: { id: true, fundName: true },
    });
    const nameByLotId = new Map(lots.map((lot) => [lot.id, lot.fundName?.trim() ?? ""]));
    for (const [planId, lotId] of depositLotIdByPlanId) {
      const name = nameByLotId.get(lotId);
      if (name) names.set(planId, name);
    }
  }

  if (bondLotIdByPlanId.size > 0) {
    const lotIds = [...new Set(bondLotIdByPlanId.values())];
    const lots = await prisma.bondTransaction.findMany({
      where: { id: { in: lotIds }, deletedAt: null, householdId: params.householdId },
      select: { id: true, productName: true, bondProductId: true, BondProduct: { select: { name: true } } },
    });
    const productIds = [...new Set(lots.map((lot) => lot.bondProductId).filter((id): id is string => !!id))];
    const siblingLots =
      productIds.length > 0
        ? await prisma.bondTransaction.findMany({
            where: {
              bondProductId: { in: productIds },
              action: FundSubtype.buy,
              deletedAt: null,
              householdId: params.householdId,
            },
            select: { id: true, bondProductId: true, tradeDate: true },
            orderBy: [{ tradeDate: "asc" }, { id: "asc" }],
          })
        : [];
    const indexByLotId = new Map<string, number>();
    {
      const byProduct = new Map<string, Array<{ id: string; bondProductId: string | null; tradeDate: Date }>>();
      for (const row of siblingLots) {
        const key = row.bondProductId ?? "";
        const arr = byProduct.get(key) ?? [];
        arr.push(row);
        byProduct.set(key, arr);
      }
      for (const arr of byProduct.values()) {
        arr.sort((a, b) => a.tradeDate.getTime() - b.tradeDate.getTime() || a.id.localeCompare(b.id));
        arr.forEach((row, idx) => indexByLotId.set(row.id, idx + 1));
      }
    }
    const lotById = new Map(lots.map((lot) => [lot.id, lot]));
    for (const [planId, lotId] of bondLotIdByPlanId) {
      const lot = lotById.get(lotId);
      if (!lot) continue;
      const productName = lot.BondProduct?.name ?? lot.productName ?? "债券";
      const index = indexByLotId.get(lotId) ?? 1;
      names.set(planId, index > 1 ? `${productName} #${index}` : productName);
    }
  }

  return names;
}

/** 展示名优先级：用户自定义 planName → 目标名 → 保险产品名 → 存单名 → 计划行 fundName → 任务类型标签。 */
function resolveDisplayName(plan: PlanRow, task: ScheduledTaskPayload, lotName?: string | null) {
  return (
    plan.planName?.trim() ||
    plan.targetName?.trim() ||
    plan.insuranceProductName?.trim() ||
    lotName?.trim() ||
    plan.fundName?.trim() ||
    scheduledTaskTypeLabel(task.type)
  );
}

export async function loadNotificationFeed(params: {
  householdId: string;
  now?: Date;
}): Promise<NotificationFeed> {
  const now = params.now ?? new Date();
  const today = startOfDayUtc(now);
  const windowEnd = addDaysUtc(today, REMINDER_WINDOW_DAYS);
  const windowStart = addDaysUtc(today, -REMINDER_OVERDUE_DAYS);
  const receiptSince = addDaysUtc(today, -RECEIPT_WINDOW_DAYS);

  // 计划行一次全取（单账簿量级很小），提醒与回执共用同一份元数据。
  const plans = (await prisma.regularInvestPlan.findMany({
    where: { householdId: params.householdId },
    select: {
      id: true,
      fundName: true,
      planName: true,
      targetName: true,
      insuranceProductName: true,
      memo: true,
      taskType: true,
      amount: true,
      nextRunDate: true,
      status: true,
    },
  })) as PlanRow[];

  if (plans.length === 0) {
    return {
      reminders: [],
      overdueAutoCount: 0,
      receipt: {
        lastRunAt: null,
        lastRunCount: 0,
        lastRunAmount: 0,
        lastRunTitles: [],
        recentCount: 0,
        recentDays: RECEIPT_WINDOW_DAYS,
        groups: [],
      },
    };
  }

  const taskByPlanId = new Map(plans.map((plan) => [plan.id, decodeScheduledTaskMemo(plan.memo)]));
  const planById = new Map(plans.map((plan) => [plan.id, plan]));

  // ── 提醒 ──
  // 窗口内 + active + 不是生息记账。日常类型（定投/固定收支）只有逾期才进来：
  // 它们未来日期天天都有，列出来只是噪声；但一旦卡在过去，就是执行器没干活。
  const duePlans = plans.filter((plan) => {
    if (plan.status !== RegularInvestStatus.active) return false;
    if (plan.nextRunDate.getTime() > windowEnd.getTime()) return false;
    if (plan.nextRunDate.getTime() < windowStart.getTime()) return false;
    const kind = reminderKindOf(plan.taskType ?? taskByPlanId.get(plan.id)?.type);
    if (!kind) return false;
    if (!isUpcomingReminderKind(kind) && plan.nextRunDate.getTime() >= today.getTime()) return false;
    return true;
  });
  const lotNames = await loadPlanLotNames({
    householdId: params.householdId,
    plans: duePlans,
    taskByPlanId,
  });

  const reminders: ReminderItem[] = duePlans.map((plan) => {
    const task = taskByPlanId.get(plan.id)!;
    const kind = reminderKindOf(plan.taskType ?? task.type)!;
    const date = formatDateUtc(plan.nextRunDate);
    return {
      id: `${plan.id}:${date}`,
      kind,
      title: resolveDisplayName(plan, task, lotNames.get(plan.id)),
      date,
      daysUntil: diffDaysUtc(today, plan.nextRunDate),
      amount: Math.abs(toNumber(plan.amount)),
      planId: plan.id,
      manualConfirm: isManualConfirmReminderKind(kind),
    };
  });

  // 逾期组按"越近越靠前"排（-1 天比 -30 天更该先看），其余按日期升序。
  const urgencyRank = { overdue: 0, today: 1, upcoming: 2 } as const;
  reminders.sort((a, b) => {
    const ra = urgencyRank[reminderUrgency(a.daysUntil)];
    const rb = urgencyRank[reminderUrgency(b.daysUntil)];
    if (ra !== rb) return ra - rb;
    return ra === 0 ? b.daysUntil - a.daysUntil : a.daysUntil - b.daysUntil;
  });

  const overdueAutoCount = reminders.filter((item) => item.daysUntil < 0 && !item.manualConfirm).length;

  // ── 回执 ──
  // 真源 = 带 regularInvestPlanId 的 TxRecord。走该字段的索引，不扫全表。
  const recentRows = await prisma.txRecord.findMany({
    where: {
      householdId: params.householdId,
      deletedAt: null,
      regularInvestPlanId: { in: plans.map((plan) => plan.id) },
      createdAt: { gte: receiptSince },
    },
    select: { id: true, createdAt: true, amount: true, regularInvestPlanId: true },
    orderBy: { createdAt: "desc" },
  });

  const receipt: ExecutionReceipt = {
    lastRunAt: null,
    lastRunCount: 0,
    lastRunAmount: 0,
    lastRunTitles: [],
    recentCount: recentRows.length,
    recentDays: RECEIPT_WINDOW_DAYS,
    groups: [],
  };

  if (recentRows.length > 0) {
    const newestAt = recentRows[0].createdAt.getTime();
    const batch = recentRows.filter((row) => newestAt - row.createdAt.getTime() <= LAST_BATCH_WINDOW_MS);
    receipt.lastRunAt = recentRows[0].createdAt.toISOString();
    receipt.lastRunCount = batch.length;
    receipt.lastRunAmount = batch.reduce((sum, row) => sum + Math.abs(toNumber(row.amount)), 0);
    const batchPlanIds = [...new Set(batch.map((row) => row.regularInvestPlanId).filter((id): id is string => !!id))];
    receipt.lastRunTitles = batchPlanIds
      .slice(0, 3)
      .map((planId) => {
        const plan = planById.get(planId);
        if (!plan) return "";
        const task = taskByPlanId.get(planId)!;
        return resolveDisplayName(plan, task, lotNames.get(planId));
      })
      .filter(Boolean);

    const byTaskType = new Map<string, { count: number; amount: number }>();
    for (const row of recentRows) {
      const planId = row.regularInvestPlanId;
      if (!planId) continue;
      const plan = planById.get(planId);
      const taskType = normalizeScheduledTaskType(plan?.taskType ?? taskByPlanId.get(planId)?.type);
      const acc = byTaskType.get(taskType) ?? { count: 0, amount: 0 };
      acc.count += 1;
      acc.amount += Math.abs(toNumber(row.amount));
      byTaskType.set(taskType, acc);
    }
    receipt.groups = [...byTaskType.entries()]
      .map(([taskType, acc]) => ({
        taskType,
        label: scheduledTaskTypeLabel(taskType),
        count: acc.count,
        amount: acc.amount,
      }))
      .sort((a, b) => b.count - a.count);
  }

  return { reminders, receipt, overdueAutoCount };
}
