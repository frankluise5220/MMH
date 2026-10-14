"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ClipboardList, Trash2, Sparkles } from "lucide-react";

import { useI18n } from "@/lib/i18n";
import {
  clearDrafts,
  deleteDraft,
  draftToBillText,
  prefillAiPanel,
  useAutoDrafts,
  type AutoDraft,
} from "@/lib/client/clipboard-drafts";

/**
 * 待确认账单面板（web 端「自动记账」的确认入口）。
 *
 * 数据来自剪贴板监听（ClipboardBillListener → localStorage 草稿）。点「记一笔」把账单
 * 原文预填进 AI 面板走「解析 → 确认 → 入账」，入账后由 AI 面板侧删除对应草稿。
 * 这里只是展示 + 动作入口，不自己写账。
 */

const PANEL_WIDTH = 340;

function directionSign(direction: AutoDraft["direction"]) {
  return direction === "expense" ? "-" : direction === "income" ? "+" : "";
}

function directionLabel(direction: AutoDraft["direction"], t: (key: string) => string) {
  return direction === "expense"
    ? t("autoDraft.expense")
    : direction === "income"
      ? t("autoDraft.income")
      : t("autoDraft.transfer");
}

export function AutoDraftPanel() {
  const { t } = useI18n();
  const anchorRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const { drafts, enabled, toggleEnabled } = useAutoDrafts();

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const toggle = () => {
    if (!open) {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (rect) {
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - PANEL_WIDTH - 8));
        setPosition({ top: rect.bottom + 6, left });
      }
    }
    setOpen((prev) => !prev);
  };

  const panel = open ? (
    <div
      ref={panelRef}
      className="fixed z-[80] flex max-h-[70vh] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_16px_48px_rgba(15,23,42,0.18)]"
      style={{ width: PANEL_WIDTH, top: position?.top ?? 0, left: position?.left ?? 0 }}
    >
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <span className="text-sm font-semibold text-slate-800">{t("autoDraft.title")}</span>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-500">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => toggleEnabled(e.target.checked)}
            className="h-3.5 w-3.5 accent-indigo-600"
          />
          {t("autoDraft.enabled")}
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {drafts.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <ClipboardList className="mx-auto mb-3 text-slate-300" size={32} />
            <p className="text-sm text-slate-500">{t("autoDraft.empty")}</p>
            <p className="mt-1 text-xs text-slate-400">{t("autoDraft.emptyHint")}</p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-50">
            {drafts.map((draft) => (
              <li key={draft.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-800">
                    {draft.merchant || draft.note || t("autoDraft.unknownMerchant")}
                  </p>
                  <p className="truncate text-xs text-slate-400">
                    {directionLabel(draft.direction, t)}
                    {draft.accountHint ? ` · ${draft.accountHint}` : ""}
                  </p>
                </div>
                <span
                  className={`shrink-0 text-sm font-bold tabular-nums ${
                    draft.direction === "expense" ? "text-slate-700" : "text-emerald-600"
                  }`}
                >
                  {directionSign(draft.direction)}
                  {draft.amount.toFixed(2)}
                </span>
                <button
                  type="button"
                  onClick={() => prefillAiPanel(draftToBillText(draft))}
                  className="flex shrink-0 items-center gap-1 rounded-md bg-indigo-600 px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-700"
                >
                  <Sparkles size={13} />
                  {t("autoDraft.record")}
                </button>
                <button
                  type="button"
                  onClick={() => deleteDraft(draft.id)}
                  className="shrink-0 rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
                  aria-label={t("autoDraft.ignore")}
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {drafts.length > 0 ? (
        <div className="border-t border-slate-100 px-4 py-2">
          <button
            type="button"
            onClick={clearDrafts}
            className="text-xs text-slate-400 transition-colors hover:text-slate-600"
          >
            {t("autoDraft.clearAll")}
          </button>
        </div>
      ) : null}
    </div>
  ) : null;

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={toggle}
        className="relative flex h-7 w-6 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800"
        title={t("autoDraft.title")}
        aria-label={t("autoDraft.title")}
      >
        <ClipboardList size={16} />
        {drafts.length > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-rose-500 px-0.5 text-[9px] font-bold leading-none text-white">
            {drafts.length > 9 ? "9+" : drafts.length}
          </span>
        ) : null}
      </button>
      {typeof document === "undefined" ? null : createPortal(panel, document.body)}
    </>
  );
}
