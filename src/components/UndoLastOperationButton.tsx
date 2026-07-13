"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Undo2 } from "lucide-react";

import {
  dispatchFinanceDataChanged,
  FINANCE_DATA_CHANGED_EVENT,
  LEGACY_FINANCE_REFRESH_EVENT,
} from "@/lib/client/refresh";

type UndoState = {
  label: string;
  canUndo: boolean;
} | null;

export function UndoLastOperationButton({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<UndoState>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  async function loadState() {
    const result = await fetch("/api/v1/undo", { cache: "no-store" })
      .then((response) => response.json())
      .catch((error) => {
        console.warn("[undo] failed to load latest operation", error);
        return null;
      });
    setState(result?.ok && result.data ? result.data : null);
  }

  useEffect(() => {
    void loadState();
    const refresh = () => void loadState();
    window.addEventListener(FINANCE_DATA_CHANGED_EVENT, refresh);
    window.addEventListener(LEGACY_FINANCE_REFRESH_EVENT, refresh);
    return () => {
      window.removeEventListener(FINANCE_DATA_CHANGED_EVENT, refresh);
      window.removeEventListener(LEGACY_FINANCE_REFRESH_EVENT, refresh);
    };
  }, []);

  async function undo() {
    if (!state?.canUndo || loading) return;
    setLoading(true);
    setMessage("");
    try {
      const response = await fetch("/api/v1/undo", { method: "POST" });
      const result = await response.json().catch(() => ({ ok: false, error: "撤销失败" }));
      if (!response.ok || !result?.ok) {
        setMessage(result?.error ?? "撤销失败");
        return;
      }
      setMessage(`已撤销：${result.data.label}`);
      setState(null);
      dispatchFinanceDataChanged({ reason: "undo-entry-operation", entryIds: undefined });
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  const title = state?.canUndo ? `撤销：${state.label}` : "没有可撤销的操作";
  if (compact) {
    return (
      <button
        type="button"
        onClick={undo}
        disabled={!state?.canUndo || loading}
        className="flex h-10 w-10 items-center justify-center rounded-xl text-slate-500 transition-colors hover:bg-white hover:text-slate-900 disabled:cursor-not-allowed disabled:text-slate-300"
        title={title}
        aria-label={title}
      >
        <Undo2 size={18} />
      </button>
    );
  }

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={undo}
        disabled={!state?.canUndo || loading}
        className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-slate-600 transition-colors hover:bg-white hover:text-slate-900 disabled:cursor-not-allowed disabled:text-slate-300"
        title={title}
      >
        <Undo2 size={18} />
        <span className="min-w-0 flex-1 truncate text-left">{loading ? "正在撤销" : "撤销上一步"}</span>
      </button>
      {message ? <div className="truncate px-3 pt-1 text-[10px] text-slate-500" title={message}>{message}</div> : null}
    </div>
  );
}
