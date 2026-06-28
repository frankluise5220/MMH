"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Unlock } from "lucide-react";
import { useRouter } from "next/navigation";

import { formatMoneyYuan as formatMoney } from "@/lib/format";

export default function EditBillAmount({
  accountId,
  statementMonth,
  currentAmount,
  hasOverride,
  displayMultiplier = 1,
}: {
  accountId: string;
  statementMonth: string;
  currentAmount: number;
  hasOverride: boolean;
  displayMultiplier?: 1 | -1;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const displayAmount = currentAmount * displayMultiplier;
  const [val, setVal] = useState(String(displayAmount.toFixed(2)));
  const [saving, setSaving] = useState(false);
  const [errMsg, setErrMsg] = useState("");
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!editing) {
      setVal(String(displayAmount.toFixed(2)));
      setErrMsg("");
    }
  }, [displayAmount, editing]);

  const cancelEdit = useCallback(() => {
    setVal(String(displayAmount.toFixed(2)));
    setErrMsg("");
    setEditing(false);
  }, [displayAmount]);

  const save = useCallback(async (amount: number) => {
    if (!accountId || !statementMonth) return;
    setSaving(true);
    setErrMsg("");
    try {
      const res = await fetch("/api/v1/bill/override", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, statementMonth, amount }),
      });
      const data = await res.json();
      if (data.ok) {
        setEditing(false);
        setSaving(false);
        await new Promise((resolve) => setTimeout(resolve, 100));
        router.refresh();
        return;
      }
      setErrMsg(data.error || "保存失败");
    } catch {
      setErrMsg("网络错误");
    }
    setSaving(false);
  }, [accountId, statementMonth, router]);

  const reset = useCallback(async () => {
    if (!accountId || !statementMonth) return;
    setSaving(true);
    try {
      await fetch(`/api/v1/bill/override?accountId=${accountId}&statementMonth=${statementMonth}`, { method: "DELETE" });
      await new Promise((resolve) => setTimeout(resolve, 100));
      router.refresh();
    } catch {
      // ignore
    }
    setSaving(false);
  }, [accountId, statementMonth, router]);

  if (editing) {
    return (
      <div ref={wrapperRef} className="flex items-center gap-1">
        <input
          type="number"
          step="0.01"
          className="h-6 w-20 rounded border border-blue-300 bg-white px-1.5 text-xs text-blue-700 outline-none text-right tabular-nums"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={(e) => {
            const next = e.relatedTarget as Node | null;
            if (next && wrapperRef.current?.contains(next)) return;
            cancelEdit();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const num = parseFloat(val);
              if (Number.isFinite(num)) save(num / displayMultiplier);
            }
            if (e.key === "Escape") cancelEdit();
          }}
          autoFocus
          disabled={saving}
        />
        <button
          type="button"
          className="h-5 w-5 rounded bg-emerald-500 text-white flex items-center justify-center hover:bg-emerald-600 shrink-0"
          onClick={() => {
            const num = parseFloat(val);
            if (Number.isFinite(num)) save(num / displayMultiplier);
          }}
          disabled={saving}
          title="确认锁定"
        >
          <Check className="h-3 w-3" strokeWidth={3} />
        </button>
        {errMsg ? <span className="text-[10px] text-red-500">{errMsg}</span> : null}
      </div>
    );
  }

  return (
    <span
      className="cursor-pointer hover:text-blue-600 tabular-nums inline-flex items-center gap-1"
      onClick={() => {
        setVal(String(displayAmount.toFixed(2)));
        setErrMsg("");
        setEditing(true);
      }}
      title="点击修改账单金额"
    >
      {formatMoney(displayAmount)}
      {hasOverride ? (
        <Unlock
          className="h-3.5 w-3.5 shrink-0 cursor-pointer text-orange-400 hover:text-orange-600"
          onClick={(e) => {
            e.stopPropagation();
            void reset();
          }}
          aria-label="解锁，恢复自动计算"
        />
      ) : null}
    </span>
  );
}
