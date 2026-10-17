"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { isReportableExecution, type NotificationItem, type ReadNotificationEntry } from "@/lib/notifications";
import { NOTIFICATIONS_CHANGED_EVENT } from "@/lib/client/notification-receipts";

/**
 * 通知的已读存档（客户端）。
 *
 * 为什么存在：通知栏里的提醒是从计划行**派生**的，"我看过了"这件事服务端无从知道，
 * 也不该知道——提醒本身不是一张表里的行。所以已读状态按 id 存在本地。
 *
 * 为什么存快照而不是只存 id：提醒的 id 含执行日（`reminder:<planId>:<date>`），计划的
 * nextRunDate 一前进，旧提醒就从服务端消失了。只存 id 的话，「已读」页签会剩下一堆
 * 渲染不出来的孤儿 id。
 *
 * 有意的取舍：已读状态是**本浏览器**的。跨设备同步需要一张服务端表（UserSettings 加列
 * 或新建表）并同时改 PG / SQLite 两条迁移通道，收益（换台电脑不必重看一遍）不抵风险。
 *
 * 注：旧版本只用 `mmh_notification_read_at` 一个时间戳表示"本次执行结果已读"。那个 key
 * 现在被忽略——它只影响一个红点，迁移过来反而要凭空造快照，不值得。
 */

export const NOTIFICATION_READS_KEY = "mmh_notification_reads";

/** 上限：已读存档是"回看"，不是审计日志，超出的按标记时间淘汰。 */
const MAX_READ_ENTRIES = 200;

/** 旧 key，见文件头注释：只为清理，不再读。 */
const LEGACY_READ_AT_KEY = "mmh_notification_read_at";

function isNotificationItem(value: unknown): value is NotificationItem {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || row.id.length === 0) return false;
  if (typeof row.at !== "number" || !Number.isFinite(row.at)) return false;
  return row.type === "reminder" || row.type === "execution";
}

function isEntry(value: unknown): value is ReadNotificationEntry {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (typeof row.readAt !== "number" || !Number.isFinite(row.readAt)) return false;
  return isNotificationItem(row.item);
}

/**
 * 存档里不该有的条目：旧版本会把"0 条的执行结果"（强制刷新、开机检查）也放进通知，
 * 用户点过已读就成了这里的快照。那种条目从一开始就不该成为通知（见
 * `isReportableExecution`），回看时同样不显示；下次写入顺手把它从存储里清掉。
 */
function isReportableEntry(entry: ReadNotificationEntry) {
  return entry.item.type !== "execution" || isReportableExecution(entry.item);
}

export function readReadEntries(): ReadNotificationEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(NOTIFICATION_READS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isEntry)
      .filter(isReportableEntry)
      .sort((a, b) => b.readAt - a.readAt)
      .slice(0, MAX_READ_ENTRIES);
  } catch {
    return [];
  }
}

function writeReadEntries(entries: ReadNotificationEntry[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      NOTIFICATION_READS_KEY,
      JSON.stringify([...entries].sort((a, b) => b.readAt - a.readAt).slice(0, MAX_READ_ENTRIES)),
    );
    window.dispatchEvent(new CustomEvent(NOTIFICATIONS_CHANGED_EVENT));
  } catch {
    // 本地偏好写入失败不影响主流程
  }
}

function markRead(ids: string[], items: NotificationItem[]) {
  if (typeof window === "undefined" || items.length === 0) return;
  const at = Date.now();
  const removing = new Set(ids);
  const kept = readReadEntries().filter((entry) => !removing.has(entry.item.id));
  const added = items.map((item) => ({ item, readAt: at }));
  writeReadEntries([...added, ...kept]);
  try {
    window.localStorage.removeItem(LEGACY_READ_AT_KEY);
  } catch {
    // ignore
  }
}

/** 标记一条通知已读；已读的重复标记是幂等的（时间戳会被刷新）。 */
export function markNotificationRead(item: NotificationItem) {
  markRead([item.id], [item]);
}

/** 标记一批通知已读（"全部已读"）；同一步里用同一个时间戳，页签里看起来是一次操作。 */
export function markNotificationsRead(items: NotificationItem[]) {
  markRead(
    items.map((item) => item.id),
    items,
  );
}

export function clearReadNotifications() {
  writeReadEntries([]);
}

export function useNotificationReads() {
  const [entries, setEntries] = useState<ReadNotificationEntry[]>([]);

  useEffect(() => {
    const sync = () => setEntries(readReadEntries());
    sync();
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, sync as EventListener);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, sync as EventListener);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const readIds = useMemo(() => new Set(entries.map((entry) => entry.item.id)), [entries]);

  return {
    /** 已读存档，按标记时间倒序。 */
    entries,
    readIds,
    markRead: useCallback((item: NotificationItem) => markNotificationRead(item), []),
    markManyRead: useCallback((items: NotificationItem[]) => markNotificationsRead(items), []),
    clearRead: useCallback(() => clearReadNotifications(), []),
  };
}
