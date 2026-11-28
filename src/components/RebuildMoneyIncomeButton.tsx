"use client";

import { useState } from "react";
import { Calculator } from "lucide-react";

import { ROW_ACTION_BUTTON_BOX_CLASS } from "@/components/AdvancedDataTable";
import { showAlertDialog, showConfirmDialog, showToast } from "@/lib/client/confirm-dialog";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { todayDateLocalYmd } from "@/lib/date-utils";
import { formatMoney } from "@/lib/format";
import { useI18n } from "@/lib/i18n";

/**
 * 「续算」游标：每只基金上一次重算实际算到哪天，下次从它的下一天接着跑。
 *
 * 2026-11-26 用户裁定：重算一次只跑一年，算完弹窗告诉用户算到哪天、要继续请再点一次。
 * 游标放在模块级 Map 里（按 账户+代码 分组），组件重新挂载也不会丢；关掉页面就重置，
 * 重置后再点会从最早一笔交易重新重放这一年（结果一致，只是多跑一次）。
 */
const rebuildCursors = new Map<string, string>();

/** 还剩多少天以上就建议「直接按当前份额手工加」，别再逐年重算。 */
const MANUAL_SHARES_HINT_DAYS = 365 * 3;

/** 一次重算覆盖的天数（与服务端 DAYS_PER_BATCH 同口径）；历史超过它就属于「一年以上」。 */
const RECALC_DAYS_PER_RUN = 366;

type RebuildPreview = {
  startDate?: string | null;
  endDate?: string | null;
  totalDays?: number;
  batches?: number;
};

/** YYYY-MM-DD + 1 天（只按日历日算，不碰时区）。 */
function nextDayYmd(ymd: string): string {
  const date = new Date(`${ymd}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/** `to - from` 的天数（两个 `YYYY-MM-DD`）。 */
function daysBetweenYmd(from: string, to: string): number {
  const fromMs = new Date(`${from}T00:00:00.000Z`).getTime();
  const toMs = new Date(`${to}T00:00:00.000Z`).getTime();
  return Math.max(0, Math.round((toMs - fromMs) / 86_400_000));
}

type AccrualResponse = {
  ok?: boolean;
  error?: string;
  data?: {
    status?: "accrued" | "skipped";
    days?: number;
    totalIncome?: number;
    fromDate?: string | null;
    toDate?: string | null;
    truncated?: boolean;
    removed?: number;
    pendingFrom?: string | null;
    skippedDays?: number;
  };
};

/**
 * 货基持仓行上的「重算收益结转」按钮。
 *
 * 平时的结转是从「上次结到哪天」往后补，改过买入日期、导入过老账单之后，前面那段
 * 空白永远补不上（游标只向前）。这个按钮走 `rebuild: true` + `fundCode`：清掉这一只
 * 基金已有的结转流水，从它最早一笔交易起按每日每万份收益逐日重放（同账户其它基金不受影响）。
 *
 * 点一次只重算一年（用户 2026-11-26 裁定）：服务端删/放都限制在当前这一年，
 * 算完弹窗显示「已重算到哪天，需要继续请再点一次」，下一次请求带上 `fromDate = 那天 + 1`
 * 接着往下跑。时间太久的货基（剩余三年以上）在弹窗里建议直接按当前份额手工加。
 */
export function RebuildMoneyIncomeButton({
  accountId,
  fundCode,
  fundName,
  onManualAdd,
}: {
  accountId: string;
  fundCode: string;
  fundName?: string | null;
  /** 用户不愿意逐年重算时去开「手工新增份额」的窗口（持仓行的买入弹窗，已带好这只基金）。 */
  onManualAdd?: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const { t } = useI18n();
  const displayName = fundName?.trim() || fundCode;
  const cursorKey = `${accountId}:${fundCode}`;

  /** 只读预览：这只基金的历史有多长。问不到就当「不知道」，退回原来的一年确认框。 */
  async function fetchPreview(): Promise<RebuildPreview | null> {
    try {
      const query = `accountId=${encodeURIComponent(accountId)}&fundCode=${encodeURIComponent(fundCode)}`;
      const res = await fetch(`/api/v1/fund/money-income/accrue?${query}`);
      const payload = (await res.json()) as { ok?: boolean; data?: RebuildPreview };
      return res.ok && payload.ok === true ? (payload.data ?? null) : null;
    } catch {
      return null;
    }
  }

  async function rebuild() {
    if (loading || preparing) return;
    const resumeFrom = rebuildCursors.get(cursorKey) ?? "";

    setPreparing(true);
    let preview: RebuildPreview | null = null;
    try {
      preview = await fetchPreview();
    } finally {
      setPreparing(false);
    }

    // 2026-11-26 用户裁定：历史超过一年的货基，点重算就直接弹提示——确定就一年一年地重算，
    // 关掉提示则改为手工新增份额（按当前份额记一笔买入），不必逐年重算。
    const totalDays = preview?.totalDays ?? 0;
    if (totalDays > RECALC_DAYS_PER_RUN) {
      // 续算时（已有游标）提示的是「还剩多少」，不要把整段历史再报一遍。
      const cursorUsable = Boolean(resumeFrom) && Boolean(preview?.endDate) && resumeFrom <= (preview?.endDate ?? "");
      const fromKey = cursorUsable ? resumeFrom : (preview?.startDate ?? "-");
      const remainDays = cursorUsable && preview?.endDate
        ? daysBetweenYmd(resumeFrom, preview.endDate) + 1
        : totalDays;
      const confirmed = await showConfirmDialog({
        title: t("moneyIncomeRebuild.longRangeTitle"),
        message: t("moneyIncomeRebuild.longRangeMessage", {
          name: displayName,
          from: fromKey,
          to: preview?.endDate ?? "-",
          days: String(remainDays),
          years: String(Math.max(1, Math.round(remainDays / 365))),
          times: String(Math.ceil(remainDays / RECALC_DAYS_PER_RUN)),
        }),
        confirmLabel: t("moneyIncomeRebuild.longRangeConfirm"),
        cancelLabel: t("moneyIncomeRebuild.longRangeClose"),
        tone: "danger",
      });
      if (!confirmed) {
        if (onManualAdd) {
          onManualAdd();
        } else {
          showToast({ message: t("moneyIncomeRebuild.manualUnavailable"), tone: "error" });
        }
        return;
      }
    } else {
      const confirmed = await showConfirmDialog({
        title: t("moneyIncomeRebuild.confirmTitle"),
        message: t("moneyIncomeRebuild.confirmMessage", { name: displayName }),
        confirmLabel: t("moneyIncomeRebuild.confirmOk"),
        cancelLabel: t("moneyIncomeRebuild.cancel"),
        tone: "danger",
      });
      if (!confirmed) return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/v1/fund/money-income/accrue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // 有游标＝接着上一次算到的下一天继续；没有就从最早一笔交易起重来。
        body: JSON.stringify({ accountId, fundCode, rebuild: true, ...(resumeFrom ? { fromDate: resumeFrom } : {}) }),
      });
      const payload = (await res.json()) as AccrualResponse;
      if (!res.ok || payload.ok === false) {
        showToast({ message: payload.error ?? t("moneyIncomeRebuild.failed"), tone: "error" });
        return;
      }

      const data = payload.data;
      const days = data?.days ?? 0;
      // 缺数据不能当成「没有收益」糊过去：说明还没结到哪天、缺的几天是什么原因。
      const notes: string[] = [];
      if (data?.pendingFrom) {
        notes.push(t("moneyIncomeRebuild.pending", { from: data.pendingFrom, to: data.toDate ?? "-" }));
      }
      if ((data?.skippedDays ?? 0) > 0) {
        notes.push(t("moneyIncomeRebuild.skipped", { count: String(data?.skippedDays) }));
      }
      if (days > 0) {
        const text = t("moneyIncomeRebuild.done", {
          from: data?.fromDate ?? "-",
          to: data?.toDate ?? "-",
          days: String(days),
          amount: formatMoney(data?.totalIncome ?? 0),
        });
        if (data?.truncated) notes.unshift(t("moneyIncomeRebuild.truncated"));
        showToast({ message: [text, ...notes].join("｜") });
      } else {
        showToast({ message: notes.length > 0 ? notes.join("｜") : t("moneyIncomeRebuild.empty") });
      }

      // 一次只算一年：还有剩余（或卡在取不到万份收益的缺口）就留游标，并弹窗说清「算到哪天」。
      // 缺口（pendingFrom）优先当游标：下次从缺的那天起，不必把前面已经算好的那一年再删一遍。
      const lastTo = data?.toDate ?? null;
      const nextStart = data?.pendingFrom ?? (lastTo ? nextDayYmd(lastTo) : "");
      const moreToCompute = Boolean(nextStart) && (data?.truncated === true || Boolean(data?.pendingFrom));
      if (moreToCompute && lastTo) {
        rebuildCursors.set(cursorKey, nextStart);
        const remainingDays = daysBetweenYmd(todayDateLocalYmd(), lastTo);
        await showAlertDialog({
          title: t("moneyIncomeRebuild.continueTitle"),
          message: [
            t("moneyIncomeRebuild.continue", { to: lastTo }),
            remainingDays > MANUAL_SHARES_HINT_DAYS
              ? t("moneyIncomeRebuild.continueOldHint", { years: String(Math.ceil(remainingDays / 365)) })
              : "",
            ...notes,
          ].filter(Boolean).join("\n"),
        });
      } else if (moreToCompute && nextStart) {
        // 一天都没算成（缺口就在起点）：不留「算到哪天」可报，但要把缺口记成下次的起点。
        rebuildCursors.set(cursorKey, nextStart);
      } else {
        rebuildCursors.delete(cursorKey);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      dispatchFinanceDataChanged({ reason: "money-income-rebuild" });
    } catch (error) {
      showToast({
        message: error instanceof Error ? error.message : t("moneyIncomeRebuild.failed"),
        tone: "error",
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void rebuild();
      }}
      disabled={loading || preparing}
      className={`${ROW_ACTION_BUTTON_BOX_CLASS} border-slate-200 bg-white text-slate-500 hover:border-emerald-200 hover:bg-emerald-50 hover:text-emerald-700 disabled:opacity-50`}
      title={t("moneyIncomeRebuild.title", { name: displayName })}
      aria-label={t("moneyIncomeRebuild.button")}
    >
      <Calculator className={loading || preparing ? "animate-pulse" : undefined} />
    </button>
  );
}
