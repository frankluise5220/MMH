import { AccountKind, FundSubtype, Prisma, RegularInvestStatus } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import {
  buildAccountDisplayOption,
  DEFAULT_CREDIT_CARD_LABEL_TEMPLATE,
  type AccountDisplaySource,
  type AccountLabelField,
} from "@/lib/account-display";
import { getMaintainedAccountBalances } from "@/lib/server/account-balance";
import { addDaysUtc, formatDateUtc, startOfDayUtc, toNumber } from "@/lib/date-utils";
import {
  decodeScheduledTaskMemo,
  getLoanScheduledPlanRole,
  normalizeScheduledTaskType,
  scheduledTaskTypeLabel,
  type ScheduledTaskPayload,
} from "@/lib/scheduled-task";
import {
  isManualConfirmReminderKind,
  isOutflowReminderKind,
  isUpcomingReminderKind,
  reminderUrgency,
  type ExecutionReceipt,
  type ExecutionReceiptAccountGroup,
  type ExecutionReceiptGroup,
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
/**
 * 回执回溯窗口（天）：只用来（a）找出最近一批落账，（b）回答"近 N 天什么都没落账"。
 * **不是**用来累加条数的——面板只报最近一批的条数，窗口累计会把"本次生成 20 条"
 * 的标题和一大堆数字搅在一起。
 */
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
  accountId: string;
  cashAccountId: string | null;
  accountName: string | null;
  cashAccountName: string | null;
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
 * 出账提醒的**付款账户**——与执行器 scheduled-task-executor 的口径一致：
 * - 固定支出/固定收入：记在计划自身的账户（accountId）；
 * - 转账/保费/定投/贷款自动扣款：从资金账户（cashAccountId）扣；
 * - 「仅出账单」的贷款计划（bill 角色）不产生资金流动，不参与余额判断。
 * 返回 null 表示这条提醒不涉及账户支出，不报"余额不足"。
 */
function fundingAccountIdOf(plan: PlanRow, task: ScheduledTaskPayload, kind: ReminderKind): string | null {
  if (!isOutflowReminderKind(kind)) return null;
  if (kind === "loan_repayment" && getLoanScheduledPlanRole(task) === "bill") return null;
  if (kind === "expense") return plan.accountId ?? null;
  return plan.cashAccountId ?? null;
}

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

/**
 * 账户名渲染所需的字段。少取一个（机构、后4位、所有人、对手方）渲染出来的名字就和
 * 列表页/明细表不同，所以这里与总览页、设置页取的是同一组。
 */
const NOTIFICATION_ACCOUNT_SELECT = {
  id: true,
  name: true,
  kind: true,
  numberMasked: true,
  groupId: true,
  investProductType: true,
  Institution: { select: { name: true, shortName: true } },
  AccountGroup: { select: { name: true } },
  Counterparty: { select: { name: true, shortName: true } },
} as const;

type NotificationAccountRow = Prisma.AccountGetPayload<{ select: typeof NOTIFICATION_ACCOUNT_SELECT }>;

/**
 * 账户名一律走"账户显示格式"设置（系统设置 → 显示：机构/账户名/后4位/所有人/账户类型，
 * 顺序由用户定），和列表页、明细表、下拉框用的是同一个渲染器 —— 同一个账户在通知里
 * 叫一个名字、在别处叫另一个名字，是这个面板最容易被当成 bug 的地方。
 *
 * 账户行已经删掉时退回传进来的兜底名（流水上的名称快照）。
 */
function renderNotificationAccountName(
  account: NotificationAccountRow | null | undefined,
  fields: AccountLabelField[] | null,
  fallback = "",
) {
  if (!account) return fallback;
  const source: AccountDisplaySource = {
    id: account.id,
    name: account.name,
    kind: account.kind,
    numberMasked: account.numberMasked,
    groupId: account.groupId,
    investProductType: account.investProductType,
    Institution: account.Institution,
    // 渲染器只需要所有人的名字；`AccountDisplaySource` 要求 id，补空串即可（总览页同样写法）。
    AccountGroup: account.AccountGroup ? { id: "", name: account.AccountGroup.name } : null,
    Counterparty: account.Counterparty,
  };
  const label = buildAccountDisplayOption(source, DEFAULT_CREDIT_CARD_LABEL_TEMPLATE, { fields }).label;
  return label || fallback;
}

export async function loadNotificationFeed(params: {
  householdId: string;
  now?: Date;
  /**
   * "账户显示格式"设置（来自请求 cookie）。账户名必须按它渲染，否则面板里的账户名
   * 与别处不一致；缺省用默认格式。
   */
  accountLabelFields?: AccountLabelField[] | null;
}): Promise<NotificationFeed> {
  const now = params.now ?? new Date();
  const accountLabelFields = params.accountLabelFields ?? null;
  const today = startOfDayUtc(now);
  const windowEnd = addDaysUtc(today, REMINDER_WINDOW_DAYS);
  const windowStart = addDaysUtc(today, -REMINDER_OVERDUE_DAYS);
  const receiptSince = addDaysUtc(today, -RECEIPT_WINDOW_DAYS);

  // 计划行一次全取（单账簿量级很小），提醒与回执共用同一份元数据。
  const plans = (await prisma.regularInvestPlan.findMany({
    where: { householdId: params.householdId },
    select: {
      id: true,
      accountId: true,
      cashAccountId: true,
      accountName: true,
      cashAccountName: true,
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

  // 出账提醒的付款账户余额。用账户**维护余额**（不是计划金额）判断"够不够扣"，
  // 否则用户只会看到"要扣款"，却不知道这张卡根本扣不动。
  const fundingAccountIds = [
    ...new Set(
      duePlans
        .map((plan) => {
          const task = taskByPlanId.get(plan.id)!;
          const kind = reminderKindOf(plan.taskType ?? task.type);
          return kind ? fundingAccountIdOf(plan, task, kind) : null;
        })
        .filter((id): id is string => !!id),
    ),
  ];
  const fundingAccounts = fundingAccountIds.length
    ? await prisma.account.findMany({
        where: { id: { in: fundingAccountIds }, householdId: params.householdId },
        // 多取的是账户名的展示字段：提醒里的账户名要和别处同名（见 renderNotificationAccountName）。
        select: { ...NOTIFICATION_ACCOUNT_SELECT, billingDay: true },
      })
    : [];
  const fundingAccountById = new Map(fundingAccounts.map((account) => [account.id, account]));
  const fundingBalances =
    fundingAccounts.length > 0
      ? await getMaintainedAccountBalances(fundingAccounts, { householdId: params.householdId })
      : new Map<string, number>();

  const reminders: ReminderItem[] = duePlans.map((plan) => {
    const task = taskByPlanId.get(plan.id)!;
    const kind = reminderKindOf(plan.taskType ?? task.type)!;
    const date = formatDateUtc(plan.nextRunDate);
    const amount = Math.abs(toNumber(plan.amount));
    const fundingAccountId = fundingAccountIdOf(plan, task, kind);
    const fundingAccount = fundingAccountId ? fundingAccountById.get(fundingAccountId) ?? null : null;
    // 信用卡的"余额"不是可用现金口径（getMaintainedAccountBalances 对信用卡直接给 0），
    // 拿它判断余额不足会天天误报，所以信用卡付款账户不报警。
    const balance = fundingAccount ? fundingBalances.get(fundingAccount.id) : undefined;
    const insufficient =
      !!fundingAccount &&
      fundingAccount.kind !== AccountKind.bank_credit &&
      typeof balance === "number" &&
      amount > 0 &&
      amount > balance + 0.005;
    return {
      id: `${plan.id}:${date}`,
      kind,
      title: resolveDisplayName(plan, task, lotNames.get(plan.id)),
      date,
      daysUntil: diffDaysUtc(today, plan.nextRunDate),
      amount,
      planId: plan.id,
      manualConfirm: isManualConfirmReminderKind(kind),
      // 账户名按"账户显示格式"渲染，不直接把 Account.name 端上去。
      fundingAccountName:
        renderNotificationAccountName(fundingAccount, accountLabelFields, fundingAccount?.name ?? "") || null,
      insufficient,
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
    select: {
      id: true,
      createdAt: true,
      amount: true,
      regularInvestPlanId: true,
      accountId: true,
      accountName: true,
    },
    orderBy: { createdAt: "desc" },
  });

  // 回执按账户拆分时的账户名：优先用账户行按"账户显示格式"渲染（账户可能后来改了名、
  // 补了机构或后4位），流水上的 accountName 只是记账那一刻的快照，留作账户已删的兜底。
  const recordAccountIds = [...new Set(recentRows.map((row) => row.accountId).filter((id): id is string => !!id))];
  const recordAccounts = recordAccountIds.length
    ? await prisma.account.findMany({
        where: { id: { in: recordAccountIds } },
        select: NOTIFICATION_ACCOUNT_SELECT,
      })
    : [];
  const accountById = new Map<string, NotificationAccountRow>(
    recordAccounts.map((account) => [account.id, account]),
  );

  const receipt: ExecutionReceipt = {
    lastRunAt: null,
    lastRunCount: 0,
    lastRunAmount: 0,
    lastRunTitles: [],
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

    // 类型维度 + 账户维度：单说"生成 20 条记录"看不出是 20 笔定投还是混合类型，
    // 更看不出钱分别落在/扣自哪个账户，所以每个类型再按账户拆一层。
    //
    // 拆的必须是**同一批**（batch），不能是 7 天窗口：标题写"生成 20 条记录"、
    // 明细却按窗口累计出 122 条，用户只会认为面板在虚报。要窗口累计就得另开一块，
    // 而不是塞进"最近一批"的明细里。
    const byTaskType = new Map<
      string,
      { count: number; amount: number; accounts: Map<string, ExecutionReceiptAccountGroup> }
    >();
    for (const row of batch) {
      const planId = row.regularInvestPlanId;
      if (!planId) continue;
      const plan = planById.get(planId);
      const taskType = normalizeScheduledTaskType(plan?.taskType ?? taskByPlanId.get(planId)?.type);
      const rowAmount = Math.abs(toNumber(row.amount));
      const acc = byTaskType.get(taskType) ?? { count: 0, amount: 0, accounts: new Map() };
      acc.count += 1;
      acc.amount += rowAmount;
      const accountId = row.accountId ?? null;
      // 同一个账户必须在面板里和别处同名 —— 所以这里渲染的是账户**当前**的显示格式，
      // 而不是流水上记账时的名称快照（账户改名后快照就旧了）。
      const accountName = renderNotificationAccountName(
        accountId ? accountById.get(accountId) : undefined,
        accountLabelFields,
        row.accountName?.trim() ?? "",
      );
      const accountKey = accountId ?? `name:${accountName}`;
      const bucket = acc.accounts.get(accountKey) ?? { accountId, accountName, count: 0, amount: 0 };
      bucket.count += 1;
      bucket.amount += rowAmount;
      acc.accounts.set(accountKey, bucket);
      byTaskType.set(taskType, acc);
    }
    receipt.groups = [...byTaskType.entries()]
      .map(
        ([taskType, acc]): ExecutionReceiptGroup => ({
          taskType,
          label: scheduledTaskTypeLabel(taskType),
          count: acc.count,
          amount: acc.amount,
          accounts: [...acc.accounts.values()].sort(
            (a, b) => b.count - a.count || a.accountName.localeCompare(b.accountName),
          ),
        }),
      )
      .sort((a, b) => b.count - a.count);
  }

  return { reminders, receipt, overdueAutoCount };
}
