"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";

let startupCheckStarted = false;

function hasUsefulChange(result: unknown) {
  if (!result || typeof result !== "object") return false;
  const data = result as Record<string, unknown>;
  const executedCount = Number(data.executedCount ?? 0);
  const filled = Number(data.filled ?? data.entryFilled ?? 0);
  const navFilled = Number(data.navFilled ?? data.entryNavFilled ?? 0);
  return executedCount > 0 || filled > 0 || navFilled > 0;
}

export function DailyTaskCheck() {
  const running = useRef(false);
  const pathname = usePathname();

  useEffect(() => {
    if (startupCheckStarted || running.current) return;
    startupCheckStarted = true;

    const run = async () => {
      running.current = true;
      try {
        const planRes = await fetch("/api/v1/regular-invest/auto-execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        const planData = await planRes.json().catch(() => null);

        const pendingRes = await fetch("/api/v1/fund/refresh-pending", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        const pendingData = await pendingRes.json().catch(() => null);

        if (hasUsefulChange(planData) || hasUsefulChange(pendingData)) {
          dispatchFinanceDataChanged({ reason: "startup-check", entryIds: Array.isArray(pendingData?.entryIds) ? pendingData.entryIds : undefined });
        }
      } catch {
        startupCheckStarted = false;
      } finally {
        running.current = false;
      }
    };

    const requestIdle = window.requestIdleCallback;
    if (requestIdle) {
      const idleId = requestIdle(() => void run(), { timeout: 3000 });
      return () => window.cancelIdleCallback?.(idleId);
    }
    const timer = window.setTimeout(() => void run(), 1000);
    return () => window.clearTimeout(timer);
  }, [pathname]);

  return null;
}
