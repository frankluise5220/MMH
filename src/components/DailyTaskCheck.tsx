"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";

let startupCheckStarted = false;
let startupCheckCompleted = false;
let startupCheckAttempts = 0;
const MAX_STARTUP_CHECK_ATTEMPTS = 3;

function hasUsefulChange(result: unknown) {
  if (!result || typeof result !== "object") return false;
  const data = result as Record<string, unknown>;
  const executedCount = Number(data.executedCount ?? 0);
  const filled = Number(data.filled ?? data.entryFilled ?? 0);
  const navFilled = Number(data.navFilled ?? data.entryNavFilled ?? 0);
  return executedCount > 0 || filled > 0 || navFilled > 0;
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
    throw new Error(`${label}失败: HTTP ${res.status}`);
  }
  if (!isObject(data)) {
    throw new Error(`${label}失败: 返回数据为空`);
  }
  if (data.ok === false) {
    throw new Error(`${label}失败: ${typeof data.error === "string" ? data.error : "未知错误"}`);
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
        assertOkResponse(planRes, planData, "计划任务自动执行");

        const pendingRes = await fetch("/api/v1/fund/refresh-pending", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        const pendingData = await pendingRes.json().catch(() => null);
        assertOkResponse(pendingRes, pendingData, "基金待确认刷新");

        if (hasUsefulChange(planData) || hasUsefulChange(pendingData)) {
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
