"use client";

import { useState } from "react";
import { Calculator } from "lucide-react";

import { ROW_ACTION_BUTTON_BOX_CLASS } from "@/components/AdvancedDataTable";
import { showConfirmDialog, showToast } from "@/lib/client/confirm-dialog";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { formatMoney } from "@/lib/format";
import { useI18n } from "@/lib/i18n";

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
 * 空白永远补不上（游标只向前）。这个按钮走 `rebuild: true` + `fundCode`：只清掉这一只
 * 基金已有的结转流水，从它最早一笔交易起按每日每万份收益逐日重放，点一次就能看到
 * 「从购买以来」的完整收益，也是逐只核对历史数字的手段（同账户其它基金不受影响）。
 */
export function RebuildMoneyIncomeButton({
  accountId,
  fundCode,
  fundName,
}: {
  accountId: string;
  fundCode: string;
  fundName?: string | null;
}) {
  const [loading, setLoading] = useState(false);
  const { t } = useI18n();
  const displayName = fundName?.trim() || fundCode;

  async function rebuild() {
    if (loading) return;
    const confirmed = await showConfirmDialog({
      title: t("moneyIncomeRebuild.confirmTitle"),
      message: t("moneyIncomeRebuild.confirmMessage", { name: displayName }),
      confirmLabel: t("moneyIncomeRebuild.confirmOk"),
      cancelLabel: t("moneyIncomeRebuild.cancel"),
      tone: "danger",
    });
    if (!confirmed) return;

    setLoading(true);
    try {
      const res = await fetch("/api/v1/fund/money-income/accrue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, fundCode, rebuild: true }),
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
      disabled={loading}
      className={`${ROW_ACTION_BUTTON_BOX_CLASS} border-slate-200 bg-white text-slate-500 hover:border-emerald-200 hover:bg-emerald-50 hover:text-emerald-700 disabled:opacity-50`}
      title={t("moneyIncomeRebuild.title", { name: displayName })}
      aria-label={t("moneyIncomeRebuild.button")}
    >
      <Calculator className={loading ? "animate-pulse" : undefined} />
    </button>
  );
}
