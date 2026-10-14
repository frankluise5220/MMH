"use client";

import { useCallback, useEffect, useState } from "react";

import { parseClipboardBill } from "@/lib/client/clipboard-bill-parser";

/**
 * 剪贴板账单草稿：web 端「自动记账」的本地暂存层。
 *
 * 对齐 Android 端的 auto_draft（Room 表）：账单先在本地存成「待确认草稿」，只有用户
 * 确认后才走 AI 解析 + 入账。隐私模型一致——本地解析、确认才落账、不主动上传。
 *
 * 捕获来源是剪贴板：回到前台时试读一次（见 ClipboardBillListener），命中才写草稿。
 */

export const AUTO_DRAFT_CHANGED_EVENT = "mmh:auto-draft:changed";
export const AUTO_DRAFT_STORAGE_KEY = "mmh_auto_draft";
export const AUTO_DRAFT_ENABLED_KEY = "mmh_auto_draft_enabled";
/** 待确认账单面板 → AI 面板：把账单原文预填进输入框并展开。 */
export const AI_PREFILL_EVENT = "mmh:ai:prefill";

const MAX_DRAFTS = 50;
const DEDUP_WINDOW_MS = 5 * 60 * 1000;

export type AutoDraft = {
  id: string;
  amount: number;
  direction: "expense" | "income" | "transfer";
  merchant: string | null;
  accountHint: string | null;
  note: string | null;
  /** YYYY-MM-DD，捕获当天 */
  date: string;
  /** epoch ms */
  capturedAt: number;
};

function isDraft(value: unknown): value is AutoDraft {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string"
    && typeof row.amount === "number"
    && (row.direction === "expense" || row.direction === "income" || row.direction === "transfer")
  );
}

function readDrafts(): AutoDraft[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(AUTO_DRAFT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isDraft).slice(0, MAX_DRAFTS);
  } catch {
    return [];
  }
}

function writeDrafts(drafts: AutoDraft[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AUTO_DRAFT_STORAGE_KEY, JSON.stringify(drafts.slice(0, MAX_DRAFTS)));
    window.dispatchEvent(new CustomEvent(AUTO_DRAFT_CHANGED_EVENT));
  } catch {
    // 本地写入失败不影响主流程
  }
}

function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 剪贴板自动记账总开关（默认开，可在设置里关）。 */
export function isAutoDraftEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(AUTO_DRAFT_ENABLED_KEY);
    if (raw == null) return true;
    return raw !== "0";
  } catch {
    return true;
  }
}

export function setAutoDraftEnabled(value: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AUTO_DRAFT_ENABLED_KEY, value ? "1" : "0");
    window.dispatchEvent(new CustomEvent(AUTO_DRAFT_CHANGED_EVENT));
  } catch {
    // ignore
  }
}

/** 把一段剪贴板文本解析并落成草稿。返回 true 表示新增了一条草稿。 */
export function addClipboardDraft(text: string | null | undefined): boolean {
  if (typeof window === "undefined") return false;
  if (!isAutoDraftEnabled()) return false;
  const bill = parseClipboardBill(text);
  if (!bill) return false;

  const since = Date.now() - DEDUP_WINDOW_MS;
  const drafts = readDrafts();
  const duplicate = drafts.some(
    (d) =>
      d.amount === bill.amount
      && d.direction === bill.direction
      && d.merchant === bill.merchant
      && d.note === bill.note
      && d.capturedAt > since,
  );
  if (duplicate) return false;

  const next: AutoDraft = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    amount: bill.amount,
    direction: bill.direction,
    merchant: bill.merchant,
    accountHint: bill.accountHint,
    note: bill.note,
    date: todayYmd(),
    capturedAt: Date.now(),
  };
  writeDrafts([next, ...drafts]);
  return true;
}

export function deleteDraft(id: string) {
  if (typeof window === "undefined") return;
  writeDrafts(readDrafts().filter((d) => d.id !== id));
}

export function clearDrafts() {
  if (typeof window === "undefined") return;
  writeDrafts([]);
}

export function useAutoDrafts() {
  const [drafts, setDrafts] = useState<AutoDraft[]>([]);
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    const sync = () => {
      setDrafts(readDrafts());
      setEnabled(isAutoDraftEnabled());
    };
    sync();
    window.addEventListener(AUTO_DRAFT_CHANGED_EVENT, sync as EventListener);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(AUTO_DRAFT_CHANGED_EVENT, sync as EventListener);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const toggleEnabled = useCallback((value: boolean) => {
    setAutoDraftEnabled(value);
  }, []);

  return { drafts, enabled, toggleEnabled };
}

/** 供确认入账后调用：删除对应草稿（与 Android 保存后删草稿对齐）。 */
export function useDeleteDraft() {
  return useCallback((id: string) => deleteDraft(id), []);
}

/**
 * 把一条草稿还原成一段「账单原文」，供 AI 面板解析。AI 的 parseStatement 依赖
 * 自然语言金额/方向/商户关键词，所以这里拼成一句话比只传数字更稳。
 */
export function draftToBillText(draft: AutoDraft): string {
  const sign = draft.direction === "expense" ? "支出" : draft.direction === "income" ? "收入" : "转账";
  const amount = draft.amount.toFixed(2);
  const merchant = draft.merchant ? ` 商户：${draft.merchant}` : "";
  const account = draft.accountHint ? ` 支付方式：${draft.accountHint}` : "";
  const note = draft.note && draft.note !== draft.merchant ? ` 备注：${draft.note}` : "";
  return `${sign} ${amount} 元${merchant}${account}${note}`;
}

/** 派发「预填到 AI 面板」事件（待确认账单面板点「记一笔」时调用）。 */
export function prefillAiPanel(text: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(AI_PREFILL_EVENT, { detail: { text } }));
}
