/**
 * Notification model shared by the server (upcoming reminders) and the client
 * (execution receipts). Pure types + pure helpers only — no "use client", so
 * server components and API routes can import it too.
 *
 * Two notification families, deliberately kept apart (see the notification
 * centre design):
 * - ReminderItem: "will happen soon" — derived from RegularInvestPlan rows,
 *   never marked read, disappears once the date passes.
 * - AutoExecuteSummary: "what the system just did" — one receipt per run,
 *   deduplicated by id, read once the panel is opened.
 */

/**
 * Reminder kinds. Internal bookkeeping plan types (interest accrual) are
 * deliberately excluded — nobody needs a reminder that an interest accrual row
 * will be written. Everything else is included, because "overdue" is the one
 * signal that must never be filtered out: a plan whose next run date sits in
 * the past means the executor did not do its job.
 */
export type ReminderKind =
  | "fund_regular_invest"
  | "loan_repayment"
  | "transfer"
  | "insurance_premium"
  | "income"
  | "expense"
  | "deposit_maturity"
  | "deposit_interest_payout"
  | "bond_maturity"
  | "bond_interest_payout";

export const REMINDER_KINDS: readonly ReminderKind[] = [
  "fund_regular_invest",
  "loan_repayment",
  "transfer",
  "insurance_premium",
  "income",
  "expense",
  "deposit_maturity",
  "deposit_interest_payout",
  "bond_maturity",
  "bond_interest_payout",
];

export function isReminderKind(value: unknown): value is ReminderKind {
  return typeof value === "string" && (REMINDER_KINDS as readonly string[]).includes(value);
}

/**
 * Kinds worth warning about *before* they fall due — the "一周内到期的存单/债券/保险等"
 * list. Routine kinds (daily fund investing, fixed income/expense) are excluded
 * here because they have a date almost every day; they only ever earn a slot
 * once they are overdue.
 */
export const UPCOMING_REMINDER_KINDS: readonly ReminderKind[] = [
  "deposit_maturity",
  "deposit_interest_payout",
  "bond_maturity",
  "bond_interest_payout",
  "insurance_premium",
  "loan_repayment",
  "transfer",
];

const UPCOMING_REMINDER_KIND_SET = new Set<string>(UPCOMING_REMINDER_KINDS);

/** Whether this kind belongs in the "due soon" list (future dates). */
export function isUpcomingReminderKind(kind: ReminderKind): boolean {
  return UPCOMING_REMINDER_KIND_SET.has(kind);
}

/**
 * Kinds whose booking actually takes money **out of an account** — i.e. the ones
 * where "is there enough balance?" is a real question. Investment (fund regular
 * invest), insurance premium and loan repayment are included because the user
 * sees them as an outflow from the paying account. Deposits/bonds maturity and
 * payout are incoming, so they never get a balance warning.
 */
export const OUTFLOW_REMINDER_KINDS: readonly ReminderKind[] = [
  "fund_regular_invest",
  "loan_repayment",
  "transfer",
  "insurance_premium",
  "expense",
];

const OUTFLOW_REMINDER_KIND_SET = new Set<string>(OUTFLOW_REMINDER_KINDS);

/** Whether booking this kind needs a funding account with enough balance. */
export function isOutflowReminderKind(kind: ReminderKind): boolean {
  return OUTFLOW_REMINDER_KIND_SET.has(kind);
}

/**
 * Reminder-only kinds: the system will never book them on its own, the user has
 * to confirm manually. Today that is `bond_maturity` — principal arrival date
 * and amount are unknown and a write-off may be needed, so `auto-execute` skips
 * it by design and leaves the plan `active` forever. Such an item must never be
 * presented as "the system failed to run it", or every bond maturity would look
 * permanently broken.
 */
export const MANUAL_CONFIRM_REMINDER_KINDS: readonly ReminderKind[] = ["bond_maturity"];

const MANUAL_CONFIRM_REMINDER_KIND_SET = new Set<string>(MANUAL_CONFIRM_REMINDER_KINDS);

export function isManualConfirmReminderKind(kind: ReminderKind): boolean {
  return MANUAL_CONFIRM_REMINDER_KIND_SET.has(kind);
}

export type ReminderItem = {
  /** Stable key: planId + due date, so the same plan re-scheduled on a new date
   *  produces a new item and the old one ages out. */
  id: string;
  kind: ReminderKind;
  /** Display name resolved server-side (planName → targetName → insuranceProductName → fundName). */
  title: string;
  /** YYYY-MM-DD (UTC day, same convention as nextRunDate). */
  date: string;
  /** 0 = today, negative = already overdue. */
  daysUntil: number;
  amount: number | null;
  planId: string;
  /**
   * True when the plan is a reminder only and the system will never book it on
   * its own — today that is `bond_maturity` (principal arrival date/amount are
   * unknown and may need a write-off, so `auto-execute` skips it by design and
   * keeps the plan `active` forever). Such an item must be shown as "confirm
   * manually", never as "the system failed to run it", otherwise every bond
   * maturity would look permanently overdue.
   */
  manualConfirm: boolean;
  /**
   * 付款/扣款账户名（仅出账类提醒有）。用于「余额不足」提示里点名账户。
   * 按"账户显示格式"设置渲染（机构/账户名/后4位…），与列表页同名 —— 见
   * `renderNotificationAccountName`。
   */
  fundingAccountName?: string | null;
  /**
   * 出账类提醒（定投/贷款/转账/保费/固定支出）在付款账户当前余额不足时置 true
   * —— 面板要用不同颜色标示，否则用户只看到"要扣款"却不知道扣不动。
   * 账户缺失或信用卡（余额口径不适用）时为 false/undefined，即不报警。
   */
  insufficient?: boolean;
  /**
   * With the "balance guard" setting on, this **due** plan was withheld by automatic
   * execution (insufficient balance → nothing was booked). The server only sets it
   * when the guard is on, the plan is overdue and the funding account is short, so it
   * is equivalent to "this scheduled task failed"; the panel renders the failure badge
   * plus the "ignore balance and generate" button (a manual path that never checks the
   * balance).
   */
  blocked?: boolean;
};

export type ReminderUrgency = "overdue" | "today" | "upcoming";

/** Bucket a reminder by how far away its date is. */
export function reminderUrgency(daysUntil: number): ReminderUrgency {
  if (daysUntil < 0) return "overdue";
  if (daysUntil === 0) return "today";
  return "upcoming";
}

export type AutoExecuteSummary = {
  rounds: number;
  /** Records actually generated by this run. 0 means nothing was written. */
  executed: number;
  completed: number;
  /** Plans skipped because their fund suspends purchases. */
  skippedPaused: number;
  /** Plans skipped because the confirm date truly has no NAV (market holiday). */
  skippedGap: number;
  /** All skips reported by the server — includes "not due yet", so it must not
   *  be presented as "plans needing attention". */
  skippedTotal: number;
};

export type ReceiptLevel = "success" | "info" | "warning";

/**
 * Level policy — this is the whole point of the receipt: never report success
 * when nothing was written.
 * - warning: nothing generated, but the run had skips worth a look
 *   (suspended purchases / confirmed NAV gaps).
 * - success: at least one record generated.
 * - info: nothing to do this time.
 */
export function receiptLevel(summary: AutoExecuteSummary): ReceiptLevel {
  if (summary.executed > 0) return "success";
  if (summary.skippedPaused + summary.skippedGap > 0) return "warning";
  return "info";
}

/**
 * Per-account split inside one task-type group — "A账户 3 条定投记录，B账户 …".
 * Without this, a bare "生成 20 条记录" is unreadable: the user cannot tell
 * whether it was 20 fund regular investments or a mix, and cannot tell which
 * account each record landed on.
 */
export type ExecutionReceiptAccountGroup = {
  accountId: string | null;
  /**
   * 账户的**显示名**，按"账户显示格式"设置（机构/账户名/后4位/所有人/账户类型）渲染，
   * 与列表页、明细表、下拉框同名。账户已删时退回流水上的名称快照，不是 `Account.name`。
   */
  accountName: string;
  count: number;
  amount: number;
};

export type ExecutionReceiptGroup = {
  taskType: string;
  label: string;
  count: number;
  amount: number;
  /** Per-account split within this task type, largest first. */
  accounts: ExecutionReceiptAccountGroup[];
};

/**
 * Persistent receipt, derived server-side from the records the executors
 * actually wrote (TxRecord rows carrying `regularInvestPlanId`). This is the
 * cross-device, reload-proof answer to "did the system run?" — unlike the
 * client-side AutoExecuteSummary, which only knows about a run this browser
 * happened to trigger and is lost on refresh.
 */
export type ExecutionReceipt = {
  /** ISO timestamp of the newest batch of system-booked records; null when the window is empty. */
  lastRunAt: string | null;
  /** Records booked by that newest batch. 0 + lastRunAt === null means "nothing ran". */
  lastRunCount: number;
  lastRunAmount: number;
  /** A few plan titles touched by the newest batch, for "…包含 A、B 等". */
  lastRunTitles: string[];
  /** Look-back window length in days, so the UI can say "近 N 天" when nothing ran. */
  recentDays: number;
  /**
   * Per-task-type breakdown of **that same newest batch**, largest first, each with a
   * per-account split. Deliberately not a window aggregate: the group counts must add
   * up to `lastRunCount`, or the panel reads as "生成 20 条" over a breakdown of 122.
   */
  groups: ExecutionReceiptGroup[];
};

/**
 * Receipt level for the persistent feed. Deliberately softer than
 * `receiptLevel`: an empty window is normal (a monthly plan simply is not due),
 * so it must not be dressed up as a warning.
 */
export function receiptLevelFromFeed(receipt: ExecutionReceipt): ReceiptLevel {
  return receipt.lastRunCount > 0 ? "success" : "info";
}

/**
 * 这次执行值不值得当成一条"执行结果"报出来。
 *
 * 强制刷新（F5 / Ctrl+F5）+ 0 条：用户只是把页面重新拉起来，计划任务一个都没轮到。
 * 既没有可看的数字，也没有要处理的异常，留在通知里只会把真正的提醒挤下去 ——
 * 所以这种情况不落档、不入列，"已读"存档里也不留（旧版本写下的那些由读取端滤掉）。
 *
 * 开机检查 / 手动执行的 0 条**相反**必须留：那是"系统查完了、确实没东西可写"，
 * 和"用户刷新了一下页面"不是一回事。
 */
export function isReportableExecution(input: { source: string; executed: number }): boolean {
  return !(input.source === "reload" && input.executed === 0);
}

/**
 * 同一批落账的时间判定窗口。
 *
 * 两个时间戳来自不同的钟：
 *  - 服务端回执的批次时间 = 这一批记录写入 DB 时的 `createdAt`（事务中间）；
 *  - 本地收据的时间 = 浏览器**收到响应**的时刻（事务之后，还要等净值回填与持仓重算）。
 *
 * 所以同一批落账天然是"服务端略早、本地略晚"，两者相差的就是响应延迟。延迟上限给到
 * 15 分钟：定投补跑多轮 + 多只基金回源净值时，整段响应可能跑好几分钟。
 * 反向留 2 分钟容差，容忍 DB 与浏览器的时钟偏差。
 */
export const SAME_BATCH_MAX_LAG_MS = 15 * 60 * 1000;
export const SAME_BATCH_MAX_LEAD_MS = 2 * 60 * 1000;

/**
 * 「本次执行结果」（本地收据）与「系统执行情况」（服务端回执）是否在说**同一批落账**。
 *
 * 是同一批时，两条通知会在面板里连成"生成 42 条记录"×2 —— 只落账了一次，却报了两次。
 * 判据刻意不看条数：本地计数是执行器返回的原始值（存款按"期"、债券按"期×2"计），
 * 与服务端流水行数不必相等；时间才是两者的公共事实。
 *
 * 本地那条生成 0 条时判负：那次执行没写任何记录，服务端回执里的批次必然属于别的事情，
 * 两条信息不同，都该留着。
 */
export function isSameExecutionBatch(
  local: NotificationItem | null,
  server: NotificationItem | null,
): boolean {
  if (!local || !server) return false;
  if (local.type !== "execution" || server.type !== "execution") return false;
  if (local.executed <= 0) return false;
  const delta = server.at - local.at;
  return delta >= -SAME_BATCH_MAX_LAG_MS && delta <= SAME_BATCH_MAX_LEAD_MS;
}

/**
 * 通知中心里**可被标记已读**的一条通知。
 *
 * 为什么把提醒也做成"有 id 的通知"，而不是维持"派生列表、不记已读"：
 * 提醒是从计划行派生的，用户对它的真实诉求是"这条我看过了，别再出现在未读里"。
 *
 * 为什么已读状态存的是**快照**而不是 id：提醒的 id 含执行日，计划的 nextRunDate
 * 一前进，旧提醒就从服务端消失了。只存 id 的话，「已读」页签会剩下一堆无法渲染
 * 的孤儿 id。
 */
export type NotificationItem =
  | {
      /** 稳定去重 id：`reminder:<planId>:<date>`。 */
      id: string;
      type: "reminder";
      kind: ReminderKind;
      /** 发生时间（epoch ms）——这里取计划执行日 UTC 零点。 */
      at: number;
      /** 展示用日期 YYYY-MM-DD。 */
      date: string;
      /** 服务端给的计划显示名（用户数据，不随界面语言变化）。 */
      title: string;
      amount: number | null;
    }
  | {
      /**
       * 执行回执。三种来源共用一个形状：
       *  - `run:<browser receipt id>`：本浏览器刚触发的那一次执行（含"生成 0 条"，
       *    但强制刷新 + 0 条不发通知，见 isReportableExecution）；
       *  - `server-run:<lastRunAt>`：服务端从真实落账算出的最新一批。
       *
       * 两者说同一批落账时**只报前者**（见 isSameExecutionBatch）：后者是同一次执行的
       * 第二个说法，并列会变成两条"生成 42 条记录"。
       */
      id: string;
      type: "execution";
      at: number;
      date: string;
      /** 真实落账条数。0 = 跑了但没写记录，必须与"没跑过"区分。 */
      executed: number;
      skippedTotal: number;
      /**
       * `startup` 开机检查（系统主动）、`reload` 强制刷新（用户被动触发）、
       * `manual` 手动执行、`server` 服务端真实落账。
       */
      source: "startup" | "reload" | "manual" | "server";
    };

/** 已读存档里的一条：快照 + 标记时间。 */
export type ReadNotificationEntry = {
  item: NotificationItem;
  /** 标记已读的时刻（epoch ms）。 */
  readAt: number;
};

function toCount(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Extract the fields the receipt shows from a POST /api/v1/regular-invest/auto-execute body. */
export function summarizeAutoExecute(data: unknown): AutoExecuteSummary | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.ok === false) return null;
  return {
    rounds: toCount(d.rounds),
    executed: toCount(d.executedCount),
    completed: toCount(d.completedCount),
    skippedPaused: toCount(d.skippedPaused),
    skippedGap: toCount(d.skippedGap),
    skippedTotal: toCount(d.skippedCount),
  };
}
