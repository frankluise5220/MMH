"use client";

import { useEffect, useState } from "react";

import { isReportableExecution, type AutoExecuteSummary } from "@/lib/notifications";

/**
 * 本地「本次执行结果」收据。为什么不能只靠服务端回执：
 *
 * 服务端回执读的是**真实落账**（TxRecord），能回答"系统最近一次到底写了几条"，
 * 但它回答不了"我刚才点的那次执行结果是什么"——如果那次执行生成 0 条（例如全部
 * 判为"该日期已执行"而跳过），服务端回执上不会留下任何痕迹，用户看到的仍然是
 * "最近一次执行是 3 天前"，于是又变成"提示成功但无变化"。
 *
 * 所以这里把执行器返回的原始计数（executedCount / skippedPaused / skippedGap /
 * rounds）原样留档，供面板说明"这次到底写了什么"。
 *
 * 但 0 条的一律不留：`isReportableExecution` 判负 = 这一轮什么都没写，报不出任何东西，
 * 也不该出现在未读/已读里，所以连档都不写（读取端同时过滤，旧版本留下的也会被滤掉）。
 * 无论是开机检查、强制刷新还是手动执行，都按这条规则走。
 */

export const NOTIFICATIONS_CHANGED_EVENT = "mmh:notifications:changed";
export const NOTIFICATION_RECEIPTS_KEY = "mmh_notification_receipts";

const MAX_RECEIPTS = 10;

/**
 * 谁触发了这次执行。刻意把"开机"和"强制刷新"分开：两者跑的是同一段检查，
 * 但对用户的含义完全不同——开机是应用刚起来、系统主动查一遍；强制刷新只是
 * 用户把页面重新拉起来（F5/Ctrl+F5），属于被动触发。落点在标签上：有落账时
 * 如实写"开机检查 / 强制刷新 / 手动执行"（0 条时整条都不报，见 `isReportableExecution`）。
 */
export type ReceiptSource = "startup" | "reload" | "manual";

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
    // 滤掉不该报的那种（含旧版本写下的），顺带在下一次写入时把它们从存储里清掉。
    return parsed.filter(isReceipt).filter(isReportableExecution).slice(0, MAX_RECEIPTS);
  } catch {
    return [];
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
 * 不能因此留 3 条收据）。没什么可报的那种（0 条，不分来源）直接不写，
 * 见 `isReportableExecution`。
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
  if (!isReportableExecution(next)) return;
  writeReceipts([next, ...readReceipts().filter((row) => row.id !== id)]);
}

export function useNotificationReceipts() {
  const [receipts, setReceipts] = useState<StoredReceipt[]>([]);

  useEffect(() => {
    const sync = () => setReceipts(readReceipts());
    sync();
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, sync as EventListener);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, sync as EventListener);
      window.removeEventListener("storage", sync);
    };
  }, []);

  return receipts;
}
