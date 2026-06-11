"use client";

import { Play, Pause, Square, Trash2, Pencil } from "lucide-react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { RegularInvestForm } from "@/components/RegularInvestForm";

const STATUS_MAP: Record<string, { label: string; cls: string }> = {
  active: { label: "执行中", cls: "text-green-600" },
  paused: { label: "已暂停", cls: "text-yellow-600" },
  stopped: { label: "已终止", cls: "text-red-600" },
  completed: { label: "已完成", cls: "text-blue-600" },
};

type PlanAction = (formData: FormData) => Promise<{ ok: true } | { ok: false; error: string }>;

export function RegularInvestActionButtons({
  plan,
  cashAccounts,
  investmentAccounts,
  editAccountLabel,
  action,
}: {
  plan: {
    id: string;
    accountId: string;
    fundCode: string;
    fundName: string | null;
    amount: number;
    intervalUnit: string;
    intervalValue: number;
    executionDay?: number | null;
    startDate: string;
    endDate?: string | null;
    totalRuns?: number | null;
    status: string;
    nextRunDate: string;
    cashAccountId: string | null;
    feeRate: number | null;
    confirmDays: number | null;
    arrivalDays: number | null;
    skipPendingPreceding: boolean | null;
  };
  cashAccounts?: { id: string; label: string }[];
  investmentAccounts?: { id: string; name: string; label: string }[];
  editAccountLabel?: string;
  action: PlanAction;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  async function handleAction(actionType: "pause" | "resume" | "stop") {
    const formData = new FormData();
    formData.set("intent", "regularInvestAction");
    formData.set("planId", plan.id);
    formData.set("action", actionType);

    setSubmitting(true);
    try {
      const res = await action(formData);
      if (!res.ok) { window.alert(res.error); return; }
      await new Promise(resolve => setTimeout(resolve, 100));
      router.refresh();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "操作失败");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    const choice = window.confirm("是否同时删除该定投计划产生的交易记录？\n\n点「确定」= 删除计划 + 删除相关记录\n点「取消」= 仅删除计划，保留记录");
    const deleteRecords = choice;
    const formData = new FormData();
    formData.set("intent", "deleteRegularInvest");
    formData.set("planId", plan.id);
    formData.set("deleteRecords", deleteRecords ? "1" : "0");

    setSubmitting(true);
    try {
      const res = await action(formData);
      if (!res.ok) { window.alert(res.error); return; }
      await new Promise(resolve => setTimeout(resolve, 100));
      router.refresh();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "删除失败");
    } finally {
      setSubmitting(false);
    }
  }

  const statusInfo = STATUS_MAP[plan.status] ?? { label: plan.status, cls: "text-slate-500" };

  return (
    <>
      <div className="flex items-center gap-1">
        {plan.status === "active" && (
          <>
            <button type="button" onClick={() => handleAction("pause")} disabled={submitting} title="暂停"
              className="h-7 w-7 flex items-center justify-center rounded-md border border-slate-200 bg-white text-yellow-600 hover:bg-yellow-50 hover:border-yellow-200 disabled:opacity-50">
              <Pause className="w-3.5 h-3.5" />
            </button>
            <button type="button" onClick={() => handleAction("stop")} disabled={submitting} title="终止"
              className="h-7 w-7 flex items-center justify-center rounded-md border border-slate-200 bg-white text-red-600 hover:bg-red-50 hover:border-red-200 disabled:opacity-50">
              <Square className="w-3.5 h-3.5" />
            </button>
          </>
        )}
        {plan.status === "paused" && (
          <button type="button" onClick={() => handleAction("resume")} disabled={submitting} title="恢复"
            className="h-7 w-7 flex items-center justify-center rounded-md border border-slate-200 bg-white text-green-600 hover:bg-green-50 hover:border-green-200 disabled:opacity-50">
            <Play className="w-3.5 h-3.5" />
          </button>
        )}
        <button type="button" onClick={() => setEditOpen(true)} title="修改"
          className="h-7 w-7 flex items-center justify-center rounded-md border border-slate-200 bg-white text-blue-600 hover:bg-blue-50 hover:border-blue-200">
          <Pencil className="w-3.5 h-3.5" />
        </button>
        <button type="button" onClick={handleDelete} disabled={submitting} title="删除"
          className="h-7 w-7 flex items-center justify-center rounded-md border border-slate-200 bg-white text-red-500 hover:bg-red-50 hover:border-red-200 disabled:opacity-50">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      <RegularInvestForm
        mode="edit"
        editData={{
          id: plan.id,
          accountId: plan.accountId,
          fundCode: plan.fundCode,
          fundName: plan.fundName,
          amount: plan.amount,
          intervalUnit: plan.intervalUnit,
          intervalValue: plan.intervalValue,
          executionDay: plan.executionDay ?? null,
          startDate: plan.startDate,
          endDate: plan.endDate ?? null,
          totalRuns: plan.totalRuns ?? null,
          cashAccountId: plan.cashAccountId,
          feeRate: plan.feeRate,
          confirmDays: plan.confirmDays,
          arrivalDays: plan.arrivalDays,
          skipPendingPreceding: plan.skipPendingPreceding ?? true,
        }}
        accountId={plan.accountId}
        accountLabel={editAccountLabel ?? ""}
        editAccountLabel={editAccountLabel}
        investmentAccounts={investmentAccounts}
        cashAccounts={cashAccounts}
        showTriggerButton={false}
        open={editOpen}
        onOpenChange={setEditOpen}
        action={action}
        submitMethod="serverAction"
        onSuccess={() => setEditOpen(false)}
      />
    </>
  );
}