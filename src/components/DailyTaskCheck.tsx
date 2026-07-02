"use client";

import { useEffect, useRef } from "react";

const STORAGE_KEY = "daily_task_last_run";

function getLastRunDate(): string {
  if (typeof window === "undefined") return "";
  try { return localStorage.getItem(STORAGE_KEY) ?? ""; } catch { return ""; }
}

function setLastRunDate() {
  try { localStorage.setItem(STORAGE_KEY, new Date().toISOString().slice(0, 10)); } catch { /* noop */ }
}

function isToday(dateStr: string): boolean {
  return dateStr === new Date().toISOString().slice(0, 10);
}

export function DailyTaskCheck() {
  const running = useRef(false);

  useEffect(() => {
    const lastRun = getLastRunDate();
    if (isToday(lastRun) || running.current) return;
    running.current = true;

    (async () => {
      try {
        // 1. 执行到期定投计划
        await fetch("/api/v1/regular-invest/auto-execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });

        // 2. 获取所有持仓基金的最新净值，并补齐未确认交易净值
        const accRes = await fetch("/api/v1/accounts/internal?balances=false");
        const accData = await accRes.json();
        if (accData.ok && accData.accounts) {
          const investAccounts = accData.accounts.filter((a: any) => a.kind === "investment");
          await Promise.allSettled(
            investAccounts.map(async (acc: any) => {
              const shellRes = await fetch(
                `/api/v1/fund/shell-data?accountId=${encodeURIComponent(acc.id)}&showCleared=false&entryScope=account`
              );
              const shellData = await shellRes.json();
              if (!shellData.ok) return;

              const symbols = [...new Set([
                ...(shellData.positions ?? []).map((p: any) => p.fundCode).filter(Boolean),
                ...(shellData.pendingByCode ? Object.keys(shellData.pendingByCode) : []),
                // 还包括所有有基金代码但没有净值/份额的记录
                ...(shellData.allEntries ?? [])
                  .filter((e: any) => e.fundCode && (e.fundNav == null || e.fundUnits == null || Number(e.fundUnits) === 0))
                  .map((e: any) => e.fundCode),
              ].map((code) => String(code).trim()).filter(Boolean))];
              if (symbols.length === 0) return;

              await fetch("/api/v1/fund/refresh", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ accountId: acc.id, symbols }),
              });
            })
          );
        }

        setLastRunDate();
      } catch {
        // 静默失败，明天重试
      } finally {
        running.current = false;
      }
    })();
  }, []);

  return null;
}
