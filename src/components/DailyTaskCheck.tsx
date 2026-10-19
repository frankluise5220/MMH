"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import {
  addReceiptNavFilled,
  publishExecutionReceipt,
  type ReceiptSource,
} from "@/lib/client/notification-receipts";
import { summarizeAutoExecute } from "@/lib/notifications";

let startupCheckStarted = false;
let startupCheckCompleted = false;
let startupCheckAttempts = 0;
const MAX_STARTUP_CHECK_ATTEMPTS = 3;

/** 本标签页是否已经加载过应用；用来把"开机"和"用户刷新"分开。 */
const LOAD_SEEN_KEY = "mmh_app_loaded";

let loadSource: ReceiptSource | null = null;

/**
 * 这次检查算"开机"还是"强制刷新"。
 *
 * 判定顺序刻意先看 sessionStorage 再看导航类型：
 *  - 本标签页此前已加载过应用（标记在）→ 本次是刷新 / 后退前进 / 重进，属于**被动**，
 *    哪怕浏览器把它报成 navigate（新开页面、站内跳转后再刷新）也不会冒充系统主动执行；
 *  - 导航类型 reload / back_forward → 同样是被动；
 *  - 其余（本次会话第一次加载）→ 开机，系统主动检查一遍。
 *
 * 结果在模块级缓存：一次页面加载只判定一次，重试（最多 3 次）不会因为
 * 刚刚写下的标记而把自己重新判成刷新。
 */
function detectLoadSource(): ReceiptSource {
  if (typeof window === "undefined") return "startup";
  let seenBefore = false;
  try {
    seenBefore = window.sessionStorage.getItem(LOAD_SEEN_KEY) === "1";
    window.sessionStorage.setItem(LOAD_SEEN_KEY, "1");
  } catch {
    // 隐私模式 / 存储被禁用：拿不到标记就退化成只看导航类型
  }
  if (seenBefore) return "reload";
  const nav = performance.getEntriesByType?.("navigation")?.[0] as PerformanceNavigationTiming | undefined;
  const type = nav?.type;
  if (type) return type === "reload" || type === "back_forward" ? "reload" : "startup";
  const legacy = (performance as Performance & { navigation?: { type?: number } }).navigation?.type;
  return legacy === 1 ? "reload" : "startup";
}

function getLoadSource(): ReceiptSource {
  if (!loadSource) loadSource = detectLoadSource();
  return loadSource;
}

function hasUsefulChange(result: unknown) {
  if (!result || typeof result !== "object") return false;
  const data = result as Record<string, unknown>;
  const executedCount = Number(data.executedCount ?? 0);
  const filled = Number(data.filled ?? data.entryFilled ?? 0);
  const navFilled = Number(data.navFilled ?? data.entryNavFilled ?? 0);
  const holdingNavRefreshed = Number(data.holdingNavRefreshed ?? 0);
  const stockRefreshed = Number(data.refreshed ?? 0);
  const nameFixed = Number(data.nameFixed ?? 0);
  const depositMatured = Number(data.processed ?? 0);
  return executedCount > 0 || filled > 0 || navFilled > 0 || holdingNavRefreshed > 0 || nameFixed > 0 || stockRefreshed > 0 || depositMatured > 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function getEntryIds(result: unknown): string[] | undefined {
  if (!isObject(result) || !Array.isArray(result.entryIds)) return undefined;
  return result.entryIds.filter((id): id is string => typeof id === "string");
}

function assertOkResponse(res: Response, data: unknown, label: string) {
  if (!res.ok) {
    throw new Error(`${label} failed: HTTP ${res.status}`);
  }
  if (!isObject(data)) {
    throw new Error(`${label} failed: empty response data`);
  }
  if (data.ok === false) {
    throw new Error(`${label} failed: ${typeof data.error === "string" ? data.error : "unknown error"}`);
  }
}

export function DailyTaskCheck() {
  const running = useRef(false);
  const pathname = usePathname();

  useEffect(() => {
    if (startupCheckCompleted || startupCheckStarted || running.current || startupCheckAttempts >= MAX_STARTUP_CHECK_ATTEMPTS) return;
    let cancelled = false;
    let retryTimer: number | undefined;

    const run = async () => {
      if (cancelled || startupCheckCompleted || startupCheckStarted || running.current) return;
      startupCheckStarted = true;
      startupCheckAttempts += 1;
      running.current = true;
      try {
        const planRes = await fetch("/api/v1/regular-invest/auto-execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        const planData = await planRes.json().catch(() => null);
        assertOkResponse(planRes, planData, "scheduled task auto-execution");
        // 留回执：写了几条照实记下，来源一并带上（开机检查 / 强制刷新 / 手动执行）。
        // 0 条会在发布端被判为"没结果"直接丢掉（见 isReportableExecution）——没有数字
        // 可看，就不该占通知位；只因净值缺口 / 暂停申购没执行的计划由到期提醒报出来。
        const executionSummary = summarizeAutoExecute(planData);
        // 先落档（回执不依赖后面的净值回填是否成功），拿到 id 后再把净值条数补进去。
        const receiptId = executionSummary
          ? publishExecutionReceipt({ source: getLoadSource(), summary: executionSummary })
          : null;

        const pendingRes = await fetch("/api/v1/fund/refresh-pending", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        const pendingData = await pendingRes.json().catch(() => null);
        assertOkResponse(pendingRes, pendingData, "fund pending refresh");
        // 待确认记录的净值也是这一轮"获取净值"的一部分：navFilled 是真正补上净值的记录条数。
        if (isObject(pendingData)) addReceiptNavFilled(receiptId, Number(pendingData.navFilled ?? 0));

        const stockRes = await fetch("/api/v1/stocks/prices/refresh-daily", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        const stockData = await stockRes.json().catch(() => null);
        assertOkResponse(stockRes, stockData, "stock close price refresh");

        // 存款到期 / 取息已改为系统计划任务（由上面的 /regular-invest/auto-execute
        // 统一执行），这里不再单独扫一遍存款，避免出现第二条生成路径。

        if (hasUsefulChange(planData) || hasUsefulChange(pendingData) || hasUsefulChange(stockData)) {
          dispatchFinanceDataChanged({ reason: "startup-check", entryIds: getEntryIds(pendingData) });
        }
        startupCheckCompleted = true;
      } catch (error) {
        console.warn("[DailyTaskCheck] startup check failed", error);
        startupCheckStarted = false;
        if (!cancelled && startupCheckAttempts < MAX_STARTUP_CHECK_ATTEMPTS) {
          retryTimer = window.setTimeout(() => void run(), 5000);
        }
      } finally {
        running.current = false;
      }
    };

    const requestIdle = window.requestIdleCallback;
    if (requestIdle) {
      const idleId = requestIdle(() => void run(), { timeout: 3000 });
      return () => {
        cancelled = true;
        window.cancelIdleCallback?.(idleId);
        if (retryTimer != null) window.clearTimeout(retryTimer);
        if (!running.current && !startupCheckCompleted) startupCheckStarted = false;
      };
    }
    const timer = window.setTimeout(() => void run(), 1000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (retryTimer != null) window.clearTimeout(retryTimer);
      if (!running.current && !startupCheckCompleted) startupCheckStarted = false;
    };
  }, [pathname]);

  return null;
}