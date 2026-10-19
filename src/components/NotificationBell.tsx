"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import {
  AlertTriangle,
  Bell,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronRight,
  Info,
  Loader2,
  RefreshCw,
  Trash2,
} from "lucide-react";

import { useI18n } from "@/lib/i18n";
import { formatCurrencyMoney } from "@/lib/format";
import { FINANCE_DATA_CHANGED_EVENT, dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { APP_PREFS_EVENT, getAccountLabelFieldsPreference } from "@/lib/client/appPreferences";
import {
  useNotificationReceipts,
  type StoredReceipt,
} from "@/lib/client/notification-receipts";
import { useNotificationReads } from "@/lib/client/notification-reads";
import {
  isSameExecutionBatch,
  reminderUrgency,
  type ExecutionReceipt,
  type ExecutionReceiptGroup,
  type NotificationItem,
  type ReadNotificationEntry,
  type ReminderItem,
  type ReminderKind,
} from "@/lib/notifications";

/**
 * 通知栏。两个页签、四个语义，语义刻意分开，不混成一个"消息流"：
 *   「未读」 1. 本次执行结果 —— 这次浏览器刚触发的那一次执行，原始计数（含"生成 0 条"）；
 *           2. 系统执行情况 —— 服务端从真实落账流水算出来的回执，跨刷新/跨设备可信；
 *           3. 逾期未落账 / 一周内到期 —— 存单/债券/保险/贷款/转账的到期提醒。
 *   「已读」 用户标记过已读的通知存档。
 *
 * 关键约束：
 *  - 打开面板**不等于**已读。已读只能由用户显式标记（单条或"全部已读"），否则未读页签
 *    永远清不空，已读页签就只是摆设。
 *  - 绝不把 HTTP ok 当"已执行"。回执数字一律来自 executedCount / TxRecord，
 *    否则就会重演"提示成功执行 118 个任务，但界面毫无变化"。
 *  - 1 和 2 说同一批落账时**只报 1**：服务端回执是同一次执行的第二个说法，两条并列会
 *    变成"生成 42 条记录"×2。见 `isSameExecutionBatch`；但 2 的明细要交给 1 去展开，
 *    否则保留下来的那条点不开，"生成 22 条记录"就只剩一句空话。
 */

const PANEL_WIDTH = 360;
const AUTO_REFRESH_MS = 5 * 60 * 1000;
const STALE_AFTER_MS = 60 * 1000;

/**
 * "账户显示格式"偏好的比较键。提醒和回执里的账户名是这个设置在**服务端**渲染出来的，
 * 所以它一变就必须重取，否则面板里还挂着旧名字。
 */
function accountLabelFieldsKey() {
  return getAccountLabelFieldsPreference().join(",");
}
/** 逾期组最多逐条渲染这么多，其余折叠成"还有 N 条"（22 条卡住的定投不值得占满面板）。 */
const OVERDUE_RENDER_LIMIT = 5;

const KIND_LABEL = {
  fund_regular_invest: "notification.kind.fund_regular_invest",
  loan_repayment: "notification.kind.loan_repayment",
  transfer: "notification.kind.transfer",
  insurance_premium: "notification.kind.insurance_premium",
  income: "notification.kind.income",
  expense: "notification.kind.expense",
  deposit_maturity: "notification.kind.deposit_maturity",
  deposit_interest_payout: "notification.kind.deposit_interest_payout",
  bond_maturity: "notification.kind.bond_maturity",
  bond_interest_payout: "notification.kind.bond_interest_payout",
} as const satisfies Record<ReminderKind, string>;

/**
 * 回执分组的标题。能对上"一周内到期"文案的复用 notification.kind.*（同一套类型名），
 * 生息等内部类型的标签则由服务端给（scheduledTaskTypeLabel），不在这里硬编码。
 */
const TASK_TYPE_LABEL_KEY: Partial<Record<string, string>> = {
  fund_regular_invest: "notification.kind.fund_regular_invest",
  loan_repayment: "notification.kind.loan_repayment",
  transfer: "notification.kind.transfer",
  insurance_premium: "notification.kind.insurance_premium",
  income: "notification.kind.income",
  expense: "notification.kind.expense",
  deposit_maturity: "notification.kind.deposit_maturity",
  deposit_interest_payout: "notification.kind.deposit_interest_payout",
  bond_maturity: "notification.kind.bond_maturity",
  bond_interest_payout: "notification.kind.bond_interest_payout",
};

type Feed = {
  reminders: ReminderItem[];
  receipt: ExecutionReceipt | null;
  overdueAutoCount: number;
};

type PanelTab = "unread" | "read";

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function formatRunTime(iso: string) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** 标记已读的时刻（epoch ms）→ 展示用时间。 */
function formatTime(epochMs: number) {
  return formatRunTime(new Date(epochMs).toISOString());
}

/**
 * 执行类通知的摘要文案。
 *
 * 正常只有第一种：报生成条数。0 条根本不算一次执行结果，`isReportableExecution`
 * 在发布端和读取端都拦掉了；第二种文案留作兜底。
 */
function executionSummaryText(
  t: (key: string, params?: Record<string, string | number>) => string,
  input: { executed: number; skippedTotal: number },
) {
  if (input.executed > 0) return t("notification.thisRun.executed", { count: input.executed });
  return t("notification.thisRun.nothing", { skipped: input.skippedTotal });
}

/** 提醒 → 可标记已读的通知。id 含执行日：计划一推进日期，新的一天就是新的未读。 */
function reminderNotification(item: ReminderItem): NotificationItem {
  const parsed = Date.parse(`${item.date}T00:00:00Z`);
  return {
    id: `reminder:${item.planId}:${item.date}`,
    type: "reminder",
    kind: item.kind,
    at: Number.isFinite(parsed) ? parsed : 0,
    date: item.date,
    title: item.title,
    amount: item.amount,
  };
}

/** 本浏览器触发的执行 → 通知（收据已滤掉 0 条，走到这里的都写了记录）。 */
function receiptNotification(receipt: StoredReceipt): NotificationItem {
  return {
    id: `run:${receipt.id}`,
    type: "execution",
    at: receipt.at,
    date: formatRunTime(new Date(receipt.at).toISOString()),
    executed: receipt.executed,
    skippedTotal: receipt.skippedTotal,
    source: receipt.source,
  };
}

/** 服务端"最新一批真实落账"→ 通知。没有批次（窗口内什么都没写）就没有这条通知。 */
function serverReceiptNotification(receipt: ExecutionReceipt | null): NotificationItem | null {
  if (!receipt?.lastRunAt || receipt.lastRunCount <= 0) return null;
  const parsed = Date.parse(receipt.lastRunAt);
  if (!Number.isFinite(parsed)) return null;
  return {
    id: `server-run:${receipt.lastRunAt}`,
    type: "execution",
    at: parsed,
    date: formatRunTime(receipt.lastRunAt),
    executed: receipt.lastRunCount,
    skippedTotal: 0,
    source: "server",
  };
}

export function NotificationBell({ collapsed }: { collapsed: boolean }) {
  const { t } = useI18n();
  const anchorRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const lastLoadedAtRef = useRef(0);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [feed, setFeed] = useState<Feed>({ reminders: [], receipt: null, overdueAutoCount: 0 });
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<PanelTab>("unread");
  const receipts = useNotificationReceipts();
  const { entries: readEntries, readIds, markRead, markManyRead, clearRead } = useNotificationReads();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/v1/notifications", { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (res.ok && data && data.ok) {
        setFeed({
          reminders: Array.isArray(data.reminders) ? (data.reminders as ReminderItem[]) : [],
          receipt: (data.receipt ?? null) as ExecutionReceipt | null,
          overdueAutoCount: Number(data.overdueAutoCount ?? 0) || 0,
        });
        setFailed(false);
        lastLoadedAtRef.current = Date.now();
      } else {
        setFailed(true);
      }
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // 首次挂载取一次；之后由财务数据变更事件 + 低频轮询 + 回到前台共同驱动。
  // 注意这里**不监听** NOTIFICATIONS_CHANGED_EVENT：本地收据是纯客户端状态，
  // useNotificationReceipts 自己会重渲染；再挂一个 load() 只会让每次打开面板
  // 多发一次同样的请求。真落了账时 refreshAfterScheduledExecution / DailyTaskCheck
  // 会派发 FINANCE_DATA_CHANGED_EVENT，那条路径已经覆盖。
  useEffect(() => {
    void load();
    const onFinanceChanged = () => void load();
    const timer = window.setInterval(() => void load(), AUTO_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - lastLoadedAtRef.current > STALE_AFTER_MS) {
        void load();
      }
    };
    // 账户名按"账户显示格式"在服务端渲染，改了设置就得重取一次 —— 但只对这个偏好敏感：
    // 侧栏折叠、行高之类的偏好变更不值得再拉一次通知。
    let labelFieldsKey = accountLabelFieldsKey();
    const onPrefsChanged = () => {
      const next = accountLabelFieldsKey();
      if (next === labelFieldsKey) return;
      labelFieldsKey = next;
      void load();
    };
    window.addEventListener(FINANCE_DATA_CHANGED_EVENT, onFinanceChanged as EventListener);
    window.addEventListener(APP_PREFS_EVENT, onPrefsChanged);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(FINANCE_DATA_CHANGED_EVENT, onFinanceChanged as EventListener);
      window.removeEventListener(APP_PREFS_EVENT, onPrefsChanged);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor || typeof window === "undefined") return;
    const rect = anchor.getBoundingClientRect();
    const rawLeft = collapsed ? rect.right + 8 : rect.left;
    const rawTop = collapsed ? rect.top : rect.bottom + 6;
    const left = Math.min(Math.max(rawLeft, 8), Math.max(8, window.innerWidth - PANEL_WIDTH - 8));
    const top = Math.min(Math.max(rawTop, 8), Math.max(8, window.innerHeight - 240));
    setPosition({ top, left });
  }, [collapsed]);

  // 注意：打开面板**不**标记已读。已读是用户的动作，一打开就清空未读等于没有未读页签。
  const openPanel = useCallback(() => {
    updatePosition();
    setOpen(true);
    void load();
  }, [load, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && (anchorRef.current?.contains(target) || panelRef.current?.contains(target))) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onReposition = () => updatePosition();
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [open, updatePosition]);

  const latestReceipt: StoredReceipt | null = receipts[0] ?? null;

  // 每一条通知都带一个稳定 id，未读判断一律走 readIds。提醒的 id 含执行日，
  // 所以计划推进到下一个执行日时会重新变成未读——那是对的，新的一天是新的一次。
  const reminderNotes = useMemo(
    () => feed.reminders.map((item) => ({ item, note: reminderNotification(item) })),
    [feed.reminders],
  );
  const unreadReminders = useMemo(
    () => reminderNotes.filter(({ note }) => !readIds.has(note.id)),
    [reminderNotes, readIds],
  );

  // 逾期 = 日期已过且**系统本该自动落账**。手工确认类（债券到期）日期过了也不是故障，
  // 它是待办，所以留在到期列表里，靠「需手工确认」角标表达。
  const overdueUnread = useMemo(
    () => unreadReminders.filter(({ item }) => item.daysUntil < 0 && !item.manualConfirm),
    [unreadReminders],
  );
  const dueUnread = useMemo(
    () => unreadReminders.filter(({ item }) => !(item.daysUntil < 0 && !item.manualConfirm)),
    [unreadReminders],
  );

  const localNote = useMemo(() => (latestReceipt ? receiptNotification(latestReceipt) : null), [latestReceipt]);
  const rawServerNote = useMemo(() => serverReceiptNotification(feed.receipt), [feed.receipt]);
  /**
   * 同一批落账**只报一条**：本地收据已经报了这次执行的结果（条数、暂停申购、净值缺口、
   * 轮次），服务端回执再把同一批报一遍，面板里就会连出两条"生成 42 条记录"。
   *
   * 判负的情形必须保留服务端回执，那是它唯一的信息价值：
   *  - 本地没有收据（换设备、清了缓存、第一次打开面板）→ 只有服务端知道落过账；
   *  - 本地收据指向别的批次（别的设备刚跑过、本地那次生成 0 条）→ 两条说的不是一回事。
   */
  const serverNote = useMemo(
    () => (isSameExecutionBatch(localNote, rawServerNote) ? null : rawServerNote),
    [localNote, rawServerNote],
  );
  /**
   * 被去重掉的那条，**明细不能跟着消失**：本地收据只存计数，展开后的「按类型 + 账户」
   * 拆分和计划名本来就只能来自真实落账。同一批时把服务端的明细交给保留的那条显示。
   */
  const localBreakdown = useMemo(
    () =>
      rawServerNote && !serverNote && feed.receipt
        ? { groups: feed.receipt.groups, titles: feed.receipt.lastRunTitles }
        : { groups: [] as ExecutionReceiptGroup[], titles: [] as string[] },
    [rawServerNote, serverNote, feed.receipt],
  );
  const unreadExecutions = useMemo(
    () => [localNote, serverNote].filter((note): note is NotificationItem => !!note && !readIds.has(note.id)),
    [localNote, serverNote, readIds],
  );

  const unreadTotal = unreadReminders.length + unreadExecutions.length;
  const badgeCount = unreadTotal;

  const markAllRead = useCallback(() => {
    markManyRead([...unreadReminders.map(({ note }) => note), ...unreadExecutions]);
  }, [markManyRead, unreadExecutions, unreadReminders]);

  const button = (
    <button
      ref={anchorRef}
      type="button"
      onClick={() => (open ? setOpen(false) : openPanel())}
      className={
        collapsed
          ? "relative flex h-10 w-10 items-center justify-center rounded-xl text-slate-500 transition-colors hover:bg-white hover:text-slate-900"
          : "relative flex h-7 w-7 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800"
      }
      title={t("notification.title")}
      aria-label={t("notification.title")}
      aria-haspopup="dialog"
      aria-expanded={open}
    >
      <Bell size={collapsed ? 18 : 15} />
      {badgeCount > 0 ? (
        <span
          className={`absolute flex items-center justify-center rounded-full bg-rose-500 font-semibold text-white ${
            collapsed ? "-right-0.5 -top-0.5 h-4 min-w-4 px-1 text-[9px]" : "-right-1 -top-1 h-3.5 min-w-3.5 px-0.5 text-[9px]"
          }`}
        >
          {badgeCount > 99 ? "99+" : badgeCount}
        </span>
      ) : null}
    </button>
  );

  if (!open) return button;

  const panel = (
    <div
      ref={panelRef}
      className="fixed z-[1200] flex max-h-[min(560px,calc(100vh-2rem))] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white text-sm shadow-xl shadow-slate-900/12"
      style={{ top: position?.top ?? 8, left: position?.left ?? 8, width: PANEL_WIDTH }}
      role="dialog"
      aria-label={t("notification.title")}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-slate-100 px-3 py-2">
        <Bell size={14} className="text-slate-400" />
        <span className="text-xs font-semibold text-slate-700">{t("notification.title")}</span>
        <button
          type="button"
          onClick={() => void load()}
          className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
          title={t("notification.refresh")}
          aria-label={t("notification.refresh")}
        >
          {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
        </button>
      </div>

      {/* 页签 + 右侧动作（随页签变化）：未读页签给"全部已读"，已读页签给"清空存档"。 */}
      <div className="flex shrink-0 items-center gap-1 border-b border-slate-100 px-2 py-1.5">
        <TabButton active={tab === "unread"} count={unreadTotal} onClick={() => setTab("unread")}>
          {t("notification.tabs.unread")}
        </TabButton>
        <TabButton active={tab === "read"} count={readEntries.length} onClick={() => setTab("read")}>
          {t("notification.tabs.read")}
        </TabButton>
        <div className="ml-auto">
          {tab === "unread" && unreadTotal > 0 ? (
            <button
              type="button"
              onClick={markAllRead}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-slate-500 transition-colors hover:bg-emerald-50 hover:text-emerald-600"
            >
              <Check size={11} />
              {t("notification.markAllRead")}
            </button>
          ) : null}
          {tab === "read" && readEntries.length > 0 ? (
            <button
              type="button"
              onClick={clearRead}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
            >
              <Trash2 size={11} />
              {t("notification.read.clear")}
            </button>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "unread" ? (
          <>
            {localNote && latestReceipt && !readIds.has(localNote.id) ? (
              <ThisRunBlock
                receipt={latestReceipt}
                breakdown={localBreakdown.groups}
                titles={localBreakdown.titles}
                onMarkRead={() => markRead(localNote)}
              />
            ) : null}

            {serverNote ? (
              <Section title={t("notification.receipt.section")}>
                <ServerReceipt receipt={feed.receipt} failed={failed} onMarkRead={() => markRead(serverNote)} />
              </Section>
            ) : null}

            {overdueUnread.length > 0 ? (
              <Section title={t("notification.reminder.overdueSection")}>
                <OverdueHint count={feed.overdueAutoCount} />
                <ul className="divide-y divide-slate-50">
                  {overdueUnread.slice(0, OVERDUE_RENDER_LIMIT).map(({ item, note }) => (
                    <ReminderRow key={item.id} item={item} onMarkRead={() => markRead(note)} />
                  ))}
                </ul>
                {overdueUnread.length > OVERDUE_RENDER_LIMIT ? (
                  <Link
                    href="/regular-invest"
                    onClick={() => setOpen(false)}
                    className="block px-3 py-1.5 text-[11px] font-medium text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-800"
                  >
                    {t("notification.reminder.more", { count: overdueUnread.length - OVERDUE_RENDER_LIMIT })}
                  </Link>
                ) : null}
              </Section>
            ) : null}

            {dueUnread.length > 0 ? (
              <Section title={t("notification.reminder.section")}>
                <ul className="divide-y divide-slate-50">
                  {dueUnread.map(({ item, note }) => (
                    <ReminderRow key={item.id} item={item} onMarkRead={() => markRead(note)} />
                  ))}
                </ul>
              </Section>
            ) : null}

            {unreadTotal === 0 && !loading ? (
              <p className="px-3 py-6 text-center text-xs text-slate-400">{t("notification.unread.empty")}</p>
            ) : null}
          </>
        ) : readEntries.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-slate-400">{t("notification.read.empty")}</p>
        ) : (
          <ul className="divide-y divide-slate-50">
            {readEntries.map((entry) => (
              <ReadRow key={entry.item.id} entry={entry} />
            ))}
          </ul>
        )}
      </div>

      <Link
        href="/regular-invest"
        onClick={() => setOpen(false)}
        className="flex shrink-0 items-center gap-1.5 border-t border-slate-100 px-3 py-2 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900"
      >
        <CalendarClock size={13} />
        {t("notification.reminder.viewAll")}
      </Link>
    </div>
  );

  return (
    <>
      {button}
      {typeof document === "undefined" ? null : createPortal(panel, document.body)}
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-slate-100 last:border-b-0">
      <div className="px-3 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{title}</div>
      {children}
    </div>
  );
}

/** 未读 / 已读页签。计数就挂在页签上，免得"红点数字"和列表对不上。 */
function TabButton({
  active,
  count,
  onClick,
  children,
}: {
  active: boolean;
  count: number;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
        active ? "bg-slate-100 text-slate-800" : "text-slate-500 hover:bg-slate-50 hover:text-slate-700"
      }`}
    >
      {children}
      {count > 0 ? (
        <span
          className={`min-w-4 rounded-full px-1 text-center text-[10px] font-semibold tabular-nums ${
            active ? "bg-white text-slate-600" : "bg-slate-100 text-slate-500"
          }`}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

/** 单条通知的"标记已读"。常驻显示而不是 hover 才出现，否则触屏用户点不到。 */
function MarkReadButton({ onMarkRead }: { onMarkRead: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onMarkRead}
      title={t("notification.markRead")}
      aria-label={t("notification.markRead")}
      className="ml-auto mt-0.5 flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium text-slate-400 transition-colors hover:bg-emerald-50 hover:text-emerald-600"
    >
      <Check size={11} />
      {t("notification.markRead")}
    </button>
  );
}

/**
 * "N 条到期计划系统未落账"。刻意放在**逾期组**里而不是执行回执里：这是计划本身的
 * 健康状态，把回执标为已读不该让它一起消失。
 */
function OverdueHint({ count }: { count: number }) {
  const { t } = useI18n();
  if (count <= 0) return null;
  return (
    <div className="mx-3 flex items-start gap-1.5 py-1">
      <AlertTriangle size={12} className="mt-0.5 shrink-0 text-rose-500" />
      <p className="text-[11px] font-medium text-rose-600">
        {t("notification.reminder.overdueHint", { count })}
      </p>
    </div>
  );
}

/**
 * 本次执行：这一次浏览器触发的执行结果。
 *
 * 0 条的收据根本不会出现在列表里（见 `isReportableExecution`），所以走到这里的
 * 一定是"确实生成了记录"的那种。来源标签仍分三种：刷新后**有**落账时，那次执行
 * 是刷新触发的，值得如实标出来。
 *
 * 可展开：`breakdown` 是服务端那份同批落账的明细（本地收据只存计数，拿不出明细）。
 * 同一批只报一条时，明细必须跟着留下来的这条走，否则"生成 22 条记录"就变成一句
 * 点不开的空话。
 */
function ThisRunBlock({
  receipt,
  breakdown,
  titles,
  onMarkRead,
}: {
  receipt: StoredReceipt;
  breakdown: ExecutionReceiptGroup[];
  titles: string[];
  onMarkRead: () => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const nothing = receipt.executed === 0;
  const canExpand = breakdown.length > 0;
  const sourceLabel =
    receipt.source === "manual"
      ? t("notification.thisRun.source.manual")
      : receipt.source === "reload"
        ? t("notification.thisRun.source.reload")
        : t("notification.thisRun.source.startup");
  return (
    <div className="border-b border-slate-100">
      <div className="flex items-center gap-1.5 px-3 pb-1 pt-2.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
          {t("notification.thisRun.section")}
        </span>
        <span className="text-[10px] text-slate-400">
          {sourceLabel}
          {" · "}
          {formatRunTime(new Date(receipt.at).toISOString())}
        </span>
        <MarkReadButton onMarkRead={onMarkRead} />
      </div>
      <div className="flex items-start gap-2 px-3 pb-2.5">
        {nothing ? (
          // 兜底：`isReportableExecution` 已把 0 条挡在列表外，正常渲染不会走到这里。
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-500" />
        ) : (
          <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-emerald-500" />
        )}
        <div className="min-w-0 flex-1">
          {canExpand ? (
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              aria-expanded={expanded}
              title={t(expanded ? "notification.receipt.collapse" : "notification.receipt.expand")}
              className="flex items-start gap-1 rounded text-left text-xs font-medium text-slate-700 transition-colors hover:text-slate-900"
            >
              <ChevronRight
                size={12}
                className={`mt-0.5 shrink-0 text-slate-400 transition-transform ${expanded ? "rotate-90" : ""}`}
              />
              <span>{executionSummaryText(t, receipt)}</span>
            </button>
          ) : (
            <p className="text-xs font-medium text-slate-700">{executionSummaryText(t, receipt)}</p>
          )}
          <p className="mt-0.5 text-[10px] text-slate-400">
            {t("notification.thisRun.detail", {
              nav: receipt.navFilled ?? 0,
              paused: receipt.skippedPaused,
              gap: receipt.skippedGap,
              rounds: receipt.rounds,
            })}
          </p>
          {canExpand && expanded ? (
            <>
              <ReceiptBreakdown groups={breakdown} />
              {titles.length > 0 ? (
                <p className="mt-0.5 truncate text-[10px] text-slate-400" title={titles.join("、")}>
                  {t("notification.receipt.lastRunTitles", { titles: titles.join("、") })}
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** 系统执行情况：服务端从真实流水算出的回执。 */
function ServerReceipt({
  receipt,
  failed,
  onMarkRead,
}: {
  receipt: ExecutionReceipt | null;
  failed: boolean;
  onMarkRead: () => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  if (failed && !receipt) {
    return <p className="px-3 py-2 text-xs text-slate-400">{t("notification.empty")}</p>;
  }
  const hasRun = !!receipt?.lastRunAt && receipt.lastRunCount > 0;
  const groups = receipt?.groups ?? [];
  const canExpand = hasRun && groups.length > 0;
  return (
    <div className="px-3 pb-2.5 pt-1">
      <div className="flex items-start gap-2">
        {hasRun ? (
          <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-emerald-500" />
        ) : (
          <Info size={13} className="mt-0.5 shrink-0 text-slate-400" />
        )}
        <div className="min-w-0 flex-1">
          {/* 「生成 N 条记录」本身说明不了是 N 笔定投还是混合类型，点开按类型 + 账户拆开。
              拆的是**同一批**：这里各项之和必须等于标题的 N 条，不能变成"标题 20、明细 122"。 */}
          {canExpand ? (
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              aria-expanded={expanded}
              title={t(expanded ? "notification.receipt.collapse" : "notification.receipt.expand")}
              className="flex items-start gap-1 rounded text-left text-xs font-medium text-slate-700 transition-colors hover:text-slate-900"
            >
              <ChevronRight
                size={12}
                className={`mt-0.5 shrink-0 text-slate-400 transition-transform ${expanded ? "rotate-90" : ""}`}
              />
              <span>
                {t("notification.receipt.lastRun", {
                  time: formatRunTime(receipt!.lastRunAt!),
                  count: receipt!.lastRunCount,
                })}
              </span>
            </button>
          ) : (
            <p className="text-xs font-medium text-slate-700">
              {hasRun && receipt?.lastRunAt
                ? t("notification.receipt.lastRun", {
                    time: formatRunTime(receipt.lastRunAt),
                    count: receipt.lastRunCount,
                  })
                : t("notification.receipt.none", { days: receipt?.recentDays ?? 7 })}
            </p>
          )}
          {canExpand && expanded ? <ReceiptBreakdown groups={groups} /> : null}
          {hasRun && receipt && receipt.lastRunTitles.length > 0 ? (
            <p className="mt-0.5 truncate text-[10px] text-slate-400" title={receipt.lastRunTitles.join("、")}>
              {t("notification.receipt.lastRunTitles", { titles: receipt.lastRunTitles.join("、") })}
            </p>
          ) : null}
        </div>
        <MarkReadButton onMarkRead={onMarkRead} />
      </div>
    </div>
  );
}

/**
 * 回执明细：按任务类型拆一层、每个类型再按账户拆一层。两条回执位置（本次执行结果 /
 * 系统执行情况）共用同一套渲染，否则同一批落账在两个位置会有两种明细。
 *
 * 拆的必须是**同一批**（batch）：各项之和要等于标题的条数，不能变成"标题 20、明细 122"。
 */
function ReceiptBreakdown({ groups }: { groups: ExecutionReceiptGroup[] }) {
  const { t } = useI18n();
  return (
    <ul className="mt-1 space-y-1 border-l border-slate-100 pl-2">
      {groups.map((group) => (
        <li key={group.taskType}>
          <div className="flex items-baseline justify-between gap-2 text-[10px] font-semibold text-slate-600">
            <span className="truncate">
              {TASK_TYPE_LABEL_KEY[group.taskType]
                ? t(TASK_TYPE_LABEL_KEY[group.taskType]!)
                : group.label}
            </span>
            <span className="shrink-0 tabular-nums">{group.count}</span>
          </div>
          {group.accounts.length > 0 ? (
            <ul className="mt-0.5 space-y-0.5 pl-2.5">
              {group.accounts.map((account) => (
                <li
                  key={account.accountId ?? account.accountName}
                  className="flex items-baseline justify-between gap-2 text-[10px] text-slate-400"
                >
                  <span className="truncate" title={account.accountName || undefined}>
                    {account.accountName || t("notification.receipt.unknownAccount")}
                  </span>
                  <span className="shrink-0 tabular-nums">{account.count}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function ReminderRow({ item, onMarkRead }: { item: ReminderItem; onMarkRead: () => void }) {
  const { t } = useI18n();
  const [forcing, setForcing] = useState(false);
  const [forceError, setForceError] = useState<string | null>(null);
  const urgency = reminderUrgency(item.daysUntil);
  const dueText =
    urgency === "overdue"
      ? t("notification.reminder.overdue", { days: Math.abs(item.daysUntil) })
      : urgency === "today"
        ? t("notification.reminder.today")
        : t("notification.reminder.daysUntil", { days: item.daysUntil });
  // 扁平：时间紧迫度只用文字颜色表达，不再套一层彩底胶囊。
  const dueClass =
    urgency === "overdue"
      ? "text-rose-600"
      : urgency === "today"
        ? "text-amber-600"
        : "text-slate-400";
  // An outflow reminder whose funding account is short: a colour (orange) and icon that
  // differ from the due-date urgency, so "this debit will not go through" is visible at a
  // glance in the list.
  const insufficient = item.insufficient === true;
  /**
   * A plan the balance guard withheld: automatic execution booked nothing because the
   * funding account was short, which IS "this scheduled task failed" (the server sets it
   * only when the guard is on, the plan is due and the account is short — see
   * scheduled-task-balance-guard). This is more serious than the plain "the balance may
   * not cover it" hint, so it renders in red and carries the force-generate escape hatch.
   */
  const blocked = item.blocked === true;

  /**
   * "Ignore balance and generate" goes through the **manual** entry point: manual
   * execution never checks the balance (the guard only applies to automatic runs), so
   * this is exactly the user saying "spend anyway" and needs no new endpoint.
   * `batch-execute` dispatches deposits / bonds / ordinary plans / fund regular invest
   * internally, so it works for every plan type.
   */
  async function handleForceExecute() {
    if (forcing) return;
    setForcing(true);
    setForceError(null);
    try {
      const res = await fetch("/api/v1/regular-invest/batch-execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: item.planId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        setForceError(
          data?.error || t("regularInvest.client.execute.failedStatus", { status: res.status }),
        );
        return;
      }
      // Once booked, the plan advances to its next run date and the reminder disappears;
      // the bell listens to this event and refetches its own feed.
      dispatchFinanceDataChanged({ reason: "notification-force-execute" });
    } catch (error) {
      setForceError(error instanceof Error ? error.message : t("regularInvest.client.execute.failed"));
    } finally {
      setForcing(false);
    }
  }

  return (
    <li className="flex items-start gap-2 px-3 py-2">
      <span className={`mt-0.5 shrink-0 text-[10px] font-semibold tabular-nums ${dueClass}`}>
        {dueText}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium text-slate-700" title={item.title}>
            {item.title}
          </span>
          {item.manualConfirm ? (
            <span className="shrink-0 text-[9px] font-medium text-sky-600">
              {t("notification.reminder.manual")}
            </span>
          ) : null}
          {blocked ? (
            <span
              className="inline-flex shrink-0 items-center gap-0.5 text-[9px] font-semibold text-rose-600"
              title={
                item.fundingAccountName
                  ? t("notification.reminder.blockedHint", { account: item.fundingAccountName })
                  : t("notification.reminder.blocked")
              }
            >
              <AlertTriangle size={9} />
              {t("notification.reminder.blocked")}
            </span>
          ) : insufficient ? (
            <span
              className="inline-flex shrink-0 items-center gap-0.5 text-[9px] font-semibold text-orange-600"
              title={
                item.fundingAccountName
                  ? t("notification.reminder.insufficientHint", { account: item.fundingAccountName })
                  : undefined
              }
            >
              <AlertTriangle size={9} />
              {t("notification.reminder.insufficient")}
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-slate-400">
          <span className="shrink-0">{t(KIND_LABEL[item.kind])}</span>
          <span className="shrink-0">·</span>
          <span className="shrink-0 tabular-nums">{item.date}</span>
          {item.amount ? (
            <>
              <span className="shrink-0">·</span>
              <span className={`shrink-0 tabular-nums ${blocked ? "font-semibold text-rose-600" : insufficient ? "font-semibold text-orange-600" : ""}`}>
                {formatCurrencyMoney(item.amount)}
              </span>
            </>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        {blocked ? (
          <button
            type="button"
            onClick={() => void handleForceExecute()}
            disabled={forcing}
            title={t("notification.reminder.forceExecute")}
            className="flex items-center gap-0.5 whitespace-nowrap rounded px-1 py-0.5 text-[10px] font-medium text-rose-600 transition-colors hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {forcing ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
            {forcing ? t("notification.reminder.forceExecuteRunning") : t("notification.reminder.forceExecute")}
          </button>
        ) : null}
        {forceError ? (
          <span className="max-w-[140px] truncate text-[9px] text-rose-500" title={forceError}>
            {forceError}
          </span>
        ) : null}
        <MarkReadButton onMarkRead={onMarkRead} />
      </div>
    </li>
  );
}

/**
 * 已读页签里的一行。渲染的是标记时的**快照**——提醒从服务端消失后（计划推进到下一个
 * 执行日）它依然在，否则已读存档会变成一堆渲染不出来的孤儿 id。
 */
function ReadRow({ entry }: { entry: ReadNotificationEntry }) {
  const { t } = useI18n();
  const { item, readAt } = entry;
  const label = item.type === "reminder" ? t(KIND_LABEL[item.kind]) : t("notification.kind.execution");
  // 摘要文案与未读页签同一套：刷新触发的 0 条在已读存档里也必须显示为
  // "强制刷新未执行计划任务"，否则同一条通知在两个页签说法不一致。
  const title = item.type === "reminder" ? item.title : executionSummaryText(t, item);

  return (
    <li className="flex items-start gap-2 px-3 py-2">
      <span className="mt-0.5 shrink-0 text-[10px] font-medium text-slate-400">
        {label}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs text-slate-600" title={title}>
          {title}
        </p>
        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-slate-400">
          <span className="shrink-0 tabular-nums">{item.date}</span>
          {item.type === "reminder" && item.amount ? (
            <>
              <span className="shrink-0">·</span>
              <span className="shrink-0 tabular-nums">{formatCurrencyMoney(item.amount)}</span>
            </>
          ) : null}
          <span className="shrink-0">·</span>
          <span className="truncate">{t("notification.read.at", { time: formatTime(readAt) })}</span>
        </div>
      </div>
    </li>
  );
}
