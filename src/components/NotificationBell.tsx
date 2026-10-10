"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { AlertTriangle, Bell, CalendarClock, CheckCircle2, Info, Loader2, RefreshCw } from "lucide-react";

import { useI18n } from "@/lib/i18n";
import { formatCurrencyMoney } from "@/lib/format";
import { FINANCE_DATA_CHANGED_EVENT } from "@/lib/client/refresh";
import {
  useNotificationReceipts,
  type StoredReceipt,
} from "@/lib/client/notification-receipts";
import {
  reminderUrgency,
  type ExecutionReceipt,
  type ReminderItem,
  type ReminderKind,
} from "@/lib/notifications";

/**
 * 通知栏。三个语义，刻意分开，不混成一个"消息流"：
 *   1. 本次执行结果 —— 这次浏览器刚触发的那一次执行，原始计数（含"生成 0 条"）；
 *   2. 系统执行情况 —— 服务端从真实落账流水算出来的回执，跨刷新/跨设备可信；
 *   3. 一周内到期   —— 存单/债券/保险/贷款/转账的到期提醒，含逾期未落账告警。
 *
 * 关键约束：绝不把 HTTP ok 当"已执行"。回执数字一律来自 executedCount / TxRecord，
 * 否则就会重演"提示成功执行 118 个任务，但界面毫无变化"。
 */

const PANEL_WIDTH = 360;
const AUTO_REFRESH_MS = 5 * 60 * 1000;
const STALE_AFTER_MS = 60 * 1000;
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

type Feed = {
  reminders: ReminderItem[];
  receipt: ExecutionReceipt | null;
  overdueAutoCount: number;
};

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function formatRunTime(iso: string) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
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
  const { receipts, readAt, markRead, unreadCount } = useNotificationReceipts();

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
    window.addEventListener(FINANCE_DATA_CHANGED_EVENT, onFinanceChanged as EventListener);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(FINANCE_DATA_CHANGED_EVENT, onFinanceChanged as EventListener);
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

  const openPanel = useCallback(() => {
    updatePosition();
    setOpen(true);
    markRead();
    void load();
  }, [load, markRead, updatePosition]);

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

  // 逾期 = 日期已过且**系统本该自动落账**。手工确认类（债券到期）日期过了也不是故障，
  // 它是待办，所以留在到期列表里，靠「需手工确认」角标表达。
  const overdueItems = useMemo(
    () => feed.reminders.filter((item) => item.daysUntil < 0 && !item.manualConfirm),
    [feed.reminders],
  );
  const dueItems = useMemo(
    () => feed.reminders.filter((item) => !(item.daysUntil < 0 && !item.manualConfirm)),
    [feed.reminders],
  );

  const todayCount = useMemo(
    () => feed.reminders.filter((item) => reminderUrgency(item.daysUntil) === "today").length,
    [feed.reminders],
  );

  const badgeCount = feed.overdueAutoCount + todayCount + unreadCount;
  const hasContent = feed.reminders.length > 0 || feed.receipt !== null || latestReceipt !== null;

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

      <div className="min-h-0 flex-1 overflow-y-auto">
        {latestReceipt ? <ThisRunBlock receipt={latestReceipt} readAt={readAt} /> : null}

        <Section title={t("notification.receipt.section")}>
          <ServerReceipt receipt={feed.receipt} overdueAutoCount={feed.overdueAutoCount} failed={failed} />
        </Section>

        {overdueItems.length > 0 ? (
          <Section title={t("notification.reminder.overdueSection")}>
            <ul className="divide-y divide-slate-50">
              {overdueItems.slice(0, OVERDUE_RENDER_LIMIT).map((item) => (
                <ReminderRow key={item.id} item={item} />
              ))}
            </ul>
            {overdueItems.length > OVERDUE_RENDER_LIMIT ? (
              <Link
                href="/regular-invest"
                onClick={() => setOpen(false)}
                className="block px-3 py-1.5 text-[11px] font-medium text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-800"
              >
                {t("notification.reminder.more", { count: overdueItems.length - OVERDUE_RENDER_LIMIT })}
              </Link>
            ) : null}
          </Section>
        ) : null}

        <Section title={t("notification.reminder.section")}>
          {dueItems.length === 0 ? (
            <p className="px-3 py-2 text-xs text-slate-400">{t("notification.reminder.empty")}</p>
          ) : (
            <ul className="divide-y divide-slate-50">
              {dueItems.map((item) => (
                <ReminderRow key={item.id} item={item} />
              ))}
            </ul>
          )}
        </Section>

        {!hasContent && !loading ? (
          <p className="px-3 py-6 text-center text-xs text-slate-400">{t("notification.empty")}</p>
        ) : null}
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

/** 本次执行：这一次浏览器触发的执行结果，保留 0 条的情形。 */
function ThisRunBlock({ receipt, readAt }: { receipt: StoredReceipt; readAt: number }) {
  const { t } = useI18n();
  const nothing = receipt.executed === 0;
  const isUnread = receipt.at > readAt;
  return (
    <div className="border-b border-slate-100 bg-slate-50/60">
      <div className="flex items-center gap-1.5 px-3 pb-1 pt-2.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
          {t("notification.thisRun.section")}
        </span>
        {isUnread ? <span className="h-1.5 w-1.5 rounded-full bg-rose-500" /> : null}
        <span className="ml-auto text-[10px] text-slate-400">
          {receipt.source === "startup" ? t("notification.thisRun.source.startup") : t("notification.thisRun.source.manual")}
          {" · "}
          {formatRunTime(new Date(receipt.at).toISOString())}
        </span>
      </div>
      <div className="flex items-start gap-2 px-3 pb-2.5">
        {nothing ? (
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-500" />
        ) : (
          <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-emerald-500" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-slate-700">
            {nothing
              ? t("notification.thisRun.nothing", { skipped: receipt.skippedTotal })
              : t("notification.thisRun.executed", { count: receipt.executed })}
          </p>
          <p className="mt-0.5 text-[10px] text-slate-400">
            {t("notification.thisRun.detail", {
              paused: receipt.skippedPaused,
              gap: receipt.skippedGap,
              rounds: receipt.rounds,
            })}
          </p>
        </div>
      </div>
    </div>
  );
}

/** 系统执行情况：服务端从真实流水算出的回执。 */
function ServerReceipt({
  receipt,
  overdueAutoCount,
  failed,
}: {
  receipt: ExecutionReceipt | null;
  overdueAutoCount: number;
  failed: boolean;
}) {
  const { t } = useI18n();
  if (failed && !receipt) {
    return <p className="px-3 py-2 text-xs text-slate-400">{t("notification.empty")}</p>;
  }
  const hasRun = !!receipt?.lastRunAt && receipt.lastRunCount > 0;
  return (
    <div className="px-3 pb-2.5 pt-1">
      <div className="flex items-start gap-2">
        {hasRun ? (
          <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-emerald-500" />
        ) : (
          <Info size={13} className="mt-0.5 shrink-0 text-slate-400" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-slate-700">
            {hasRun && receipt?.lastRunAt
              ? t("notification.receipt.lastRun", {
                  time: formatRunTime(receipt.lastRunAt),
                  count: receipt.lastRunCount,
                })
              : t("notification.receipt.none", { days: receipt?.recentDays ?? 7 })}
          </p>
          {hasRun && receipt && receipt.lastRunTitles.length > 0 ? (
            <p className="mt-0.5 truncate text-[10px] text-slate-400" title={receipt.lastRunTitles.join("、")}>
              {t("notification.receipt.lastRunTitles", { titles: receipt.lastRunTitles.join("、") })}
            </p>
          ) : null}
          {receipt && receipt.recentCount > 0 ? (
            <p className="mt-0.5 text-[10px] text-slate-400">
              {t("notification.receipt.recentTotal", { days: receipt.recentDays, count: receipt.recentCount })}
            </p>
          ) : null}
        </div>
      </div>
      {overdueAutoCount > 0 ? (
        <div className="mt-1.5 flex items-start gap-2 rounded-lg bg-rose-50 px-2 py-1.5">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-rose-500" />
          <p className="text-[11px] font-medium text-rose-700">
            {t("notification.reminder.overdueHint", { count: overdueAutoCount })}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function ReminderRow({ item }: { item: ReminderItem }) {
  const { t } = useI18n();
  const urgency = reminderUrgency(item.daysUntil);
  const dueText =
    urgency === "overdue"
      ? t("notification.reminder.overdue", { days: Math.abs(item.daysUntil) })
      : urgency === "today"
        ? t("notification.reminder.today")
        : t("notification.reminder.daysUntil", { days: item.daysUntil });
  const dueClass =
    urgency === "overdue"
      ? "bg-rose-50 text-rose-600"
      : urgency === "today"
        ? "bg-amber-50 text-amber-600"
        : "bg-slate-100 text-slate-500";

  return (
    <li className="flex items-start gap-2 px-3 py-2">
      <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${dueClass}`}>
        {dueText}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium text-slate-700" title={item.title}>
            {item.title}
          </span>
          {item.manualConfirm ? (
            <span className="shrink-0 rounded bg-sky-50 px-1 py-0.5 text-[9px] font-medium text-sky-600">
              {t("notification.reminder.manual")}
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
              <span className="shrink-0 tabular-nums">{formatCurrencyMoney(item.amount)}</span>
            </>
          ) : null}
        </div>
      </div>
    </li>
  );
}
