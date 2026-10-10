"use client";

import { useCallback, useEffect, useState } from "react";

import type { AutoExecuteSummary } from "@/lib/notifications";

/**
 * 本地「本次执行结果」收据。为什么不能只靠服务端回执：
 *
 * 服务端回执读的是**真实落账**（TxRecord），能回答"系统最近一次到底写了几条"，
 * 但它回答不了"我刚才点的那次执行结果是什么"——如果那次执行生成 0 条（例如全部
 * 判为"该日期已执行"而跳过），服务端回执上不会留下任何痕迹，用户看到的仍然是
 * "最近一次执行是 3 天前"，于是又变成"提示成功但无变化"。
 *
 * 所以这里把执行器返回的原始计数（executedCount / skippedPaused / skippedGap /
 * rounds）原样留档，并**明确区分 0 条**与"没跑过"。
 */

export const NOTIFICATIONS_CHANGED_EVENT = "mmh:notifications:changed";
export const NOTIFICATION_RECEIPTS_KEY = "mmh_notification_receipts";
export const NOTIFICATION_READ_KEY = "mmh_notification_read_at";

const MAX_RECEIPTS = 10;

export type ReceiptSource = "startup" | "manual";

export type StoredReceipt = {
  id: string;
  /** epoch ms */
  at: number;
  source: ReceiptSource;
  executed: number;
  completed: number;
  skippedPaused: number;
  skippedGap: number;
  skippedTotal: number;
  rounds: number;
};

function isReceipt(value: unknown): value is StoredReceipt {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && typeof row.at === "number" && Number.isFinite(row.at);
}

function num(value: unknown) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function readReceipts(): StoredReceipt[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(NOTIFICATION_RECEIPTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isReceipt).slice(0, MAX_RECEIPTS);
  } catch {
    return [];
  }
}

export function readReceiptsReadAt(): number {
  if (typeof window === "undefined") return 0;
  try {
    return Number(window.localStorage.getItem(NOTIFICATION_READ_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}

function writeReceipts(receipts: StoredReceipt[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(NOTIFICATION_RECEIPTS_KEY, JSON.stringify(receipts.slice(0, MAX_RECEIPTS)));
    window.dispatchEvent(new CustomEvent(NOTIFICATIONS_CHANGED_EVENT));
  } catch {
    // 本地偏好写入失败不影响主流程
  }
}

/**
 * 记录一次执行结果。同一来源、同一分钟视为同一条（DailyTaskCheck 失败会重试 3 次，
 * 不能因此留 3 条收据）。
 */
export function publishExecutionReceipt(input: { source: ReceiptSource; summary: AutoExecuteSummary }) {
  if (typeof window === "undefined") return;
  const at = Date.now();
  const id = `${input.source}:${Math.floor(at / 60_000)}`;
  const next: StoredReceipt = {
    id,
    at,
    source: input.source,
    executed: num(input.summary.executed),
    completed: num(input.summary.completed),
    skippedPaused: num(input.summary.skippedPaused),
    skippedGap: num(input.summary.skippedGap),
    skippedTotal: num(input.summary.skippedTotal),
    rounds: num(input.summary.rounds),
  };
  writeReceipts([next, ...readReceipts().filter((row) => row.id !== id)]);
}

export function markReceiptsRead() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(NOTIFICATION_READ_KEY, String(Date.now()));
    window.dispatchEvent(new CustomEvent(NOTIFICATIONS_CHANGED_EVENT));
  } catch {
    // ignore
  }
}

export function useNotificationReceipts() {
  const [receipts, setReceipts] = useState<StoredReceipt[]>([]);
  const [readAt, setReadAt] = useState(0);

  useEffect(() => {
    const sync = () => {
      setReceipts(readReceipts());
      setReadAt(readReceiptsReadAt());
    };
    sync();
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, sync as EventListener);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, sync as EventListener);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const markRead = useCallback(() => markReceiptsRead(), []);

  return {
    receipts,
    readAt,
    markRead,
    unreadCount: receipts.filter((row) => row.at > readAt).length,
  };
}
