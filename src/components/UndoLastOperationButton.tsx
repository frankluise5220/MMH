"use client";

import { useEffect, useState } from "react";
import { Undo2 } from "lucide-react";

import {
  dispatchFinanceDataChanged,
  FINANCE_DATA_CHANGED_EVENT,
} from "@/lib/client/refresh";
import { useI18n } from "@/lib/i18n";

type UndoState = {
  label: string;
  canUndo: boolean;
  undoCount?: number;
  historyLimit?: number;
} | null;

export function UndoLastOperationButton({
  compact = false,
  className,
  iconSize = 18,
}: {
  compact?: boolean;
  className?: string;
  iconSize?: number;
}) {
  const [state, setState] = useState<UndoState>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const { t } = useI18n();

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
    return () => {
      window.removeEventListener(FINANCE_DATA_CHANGED_EVENT, refresh);
    };
  }, []);

  async function undo() {
    if (!state?.canUndo || loading) return;
    setLoading(true);
    setMessage("");
    try {
      const response = await fetch("/api/v1/undo", { method: "POST" });
      const result = await response.json().catch(() => ({ ok: false, error: t("undo.undoFailed") }));
      if (!response.ok || !result?.ok) {
        setMessage(result?.error ?? t("undo.undoFailed"));
        return;
      }
      const remainingCount = Number(result.data?.remainingCount ?? 0);
      setMessage(remainingCount > 0
        ? t("undo.doneWithMore", { label: result.data.label, count: remainingCount })
        : t("undo.done", { label: result.data.label }));
      setState(null);
      dispatchFinanceDataChanged({ reason: "undo-entry-operation", entryIds: undefined });
    } finally {
      setLoading(false);
    }
  }

  const undoCount = Number(state?.undoCount ?? 0);
  const title = state?.canUndo
    ? undoCount > 0
      ? t("undo.titleWithMore", { label: state.label, count: undoCount })
      : t("undo.title", { label: state.label })
    : t("undo.noOperations");
  if (compact) {
    return (
      <button
        type="button"
        onClick={undo}
        disabled={!state?.canUndo || loading}
        className={className ?? "flex h-10 w-10 items-center justify-center rounded-xl text-slate-500 transition-colors hover:bg-white hover:text-slate-900 disabled:cursor-not-allowed disabled:text-slate-300"}
        title={title}
        aria-label={title}
      >
        <Undo2 size={iconSize} />
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
        <span className="min-w-0 flex-1 truncate text-left">{loading ? t("undo.undoing") : t("undo.undoLastStep")}</span>
      </button>
      {message ? <div className="truncate px-3 pt-1 text-[10px] text-slate-500" title={message}>{message}</div> : null}
    </div>
  );
}
