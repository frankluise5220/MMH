"use client";

import { useState, useEffect } from "react";
import { formatMoneyLoose as formatMoney } from "@/lib/format";

type Plan = {
  id: string;
  accountId: string;
  fundCode: string;
  fundName: string | null;
  amount: string;
  intervalUnit: string;
  intervalValue: number;
  nextRunDate: string;
  isActive: boolean;
  lastRunDate: string | null;
  account: { name: string };
};

type ExecResult = {
  ok: boolean;
  message: string;
  executedCount: number;
  skippedCount: number;
  details: { planId: string; fundCode: string; action: string; reason?: string }[];
};

const INTERVAL_OPTIONS = [
  { value: "day", label: "每天" },
  { value: "week", label: "每周" },
  { value: "biweek", label: "每两周" },
  { value: "month", label: "每月" },
];

function formatDate(d: string | Date): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toISOString().slice(0, 10);
}


interface RegularInvestCheckModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function RegularInvestCheckModal({ isOpen, onClose }: RegularInvestCheckModalProps) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [execResult, setExecResult] = useState<ExecResult | null>(null);

  useEffect(() => {
    if (isOpen) {
      loadPlans();
    }
  }, [isOpen]);

  async function loadPlans() {
    setLoading(true);
    setExecResult(null);
    try {
      const res = await fetch("/api/v1/regular-invest");
      const data = await res.json();
      if (data.ok) {
        setPlans(data.plans || []);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  async function handleAutoExecute() {
    setExecuting(true);
    try {
      const res = await fetch("/api/v1/regular-invest/auto-execute", {
        method: "POST",
      });
      const data = await res.json();
      setExecResult(data);
      if (data.ok) {
        loadPlans();
      }
    } catch {
      setExecResult({ ok: false, message: "执行失败", executedCount: 0, skippedCount: 0, details: [] });
    } finally {
      setExecuting(false);
    }
  }

  const today = new Date();
  const pendingPlans = plans.filter(p => p.isActive && new Date(p.nextRunDate) <= today);
  const futurePlans = plans.filter(p => !p.isActive || new Date(p.nextRunDate) > today);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center">
      <div className="bg-white rounded-xl shadow-lg w-full max-w-lg mx-4 overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-700">计划任务检查</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            ✕
          </button>
        </div>

        <div className="p-4">
          {loading ? (
            <div className="text-center py-4 text-slate-500">加载中...</div>
          ) : (
            <>
              {pendingPlans.length > 0 && (
                <div className="mb-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-orange-600">
                      待执行 ({pendingPlans.length})
                    </span>
                    <button
                      onClick={handleAutoExecute}
                      disabled={executing}
                      className={`px-3 py-1 text-xs rounded ${
                        executing
                          ? "bg-slate-100 text-slate-400"
                          : "bg-orange-500 text-white hover:bg-orange-600"
                      }`}
                    >
                      {executing ? "执行中..." : "执行计划"}
                    </button>
                  </div>
                  <div className="bg-orange-50 border border-orange-100 rounded-lg p-2">
                    <table className="w-full text-xs">
                      <tbody>
                        {pendingPlans.map(p => (
                          <tr key={p.id} className="border-b border-orange-100 last:border-0">
                            <td className="py-1.5 text-slate-700">
                              {p.fundName || p.fundCode}
                              <span className="text-slate-400 ml-1">{p.fundCode}</span>
                            </td>
                            <td className="py-1.5 text-right font-mono text-slate-600">
                              {formatMoney(p.amount)}
                            </td>
                            <td className="py-1.5 text-right text-orange-600">
                              {formatDate(p.nextRunDate)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {execResult && (
                <div className={`mb-4 p-3 rounded-lg ${
                  execResult.ok ? "bg-green-50 border border-green-100" : "bg-red-50 border border-red-100"
                }`}>
                  <div className="text-xs font-medium text-slate-700 mb-2">{execResult.message}</div>
                  {execResult.details.length > 0 && (
                    <div className="text-xs text-slate-500">
                      {execResult.details.map(d => (
                        <div key={d.planId}>
                          {d.fundCode}: {d.action === "executed" ? "已执行" : `跳过(${d.reason})`}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {pendingPlans.length === 0 && !execResult && (
                <div className="text-center py-4 text-slate-500 text-xs">
                  当前没有待执行的计划任务
                </div>
              )}

              {futurePlans.length > 0 && (
                <div className="mt-4">
                  <span className="text-xs font-medium text-slate-500">
                    已安排 ({futurePlans.length})
                  </span>
                  <div className="bg-slate-50 border border-slate-100 rounded-lg p-2 mt-1">
                    <table className="w-full text-xs">
                      <tbody>
                        {futurePlans.map(p => (
                          <tr key={p.id} className="border-b border-slate-100 last:border-0">
                            <td className="py-1.5 text-slate-700">
                              {p.fundName || p.fundCode}
                              <span className="text-slate-400 ml-1">{p.fundCode}</span>
                              {!p.isActive && <span className="ml-1 text-slate-300">(暂停)</span>}
                            </td>
                            <td className="py-1.5 text-right font-mono text-slate-600">
                              {formatMoney(p.amount)}
                            </td>
                            <td className="py-1.5 text-right text-slate-500">
                              {INTERVAL_OPTIONS.find(o => o.value === p.intervalUnit)?.label}
                              {p.intervalValue > 1 && `×${p.intervalValue}`}
                            </td>
                            <td className="py-1.5 text-right text-slate-500">
                              {formatDate(p.nextRunDate)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="px-4 py-3 border-t border-slate-200 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs bg-slate-100 text-slate-600 rounded hover:bg-slate-200"
          >
            关闭
          </button>
          <button
            onClick={() => window.location.href = "/regular-invest"}
            className="px-3 py-1.5 text-xs bg-blue-500 text-white rounded hover:bg-blue-600"
          >
            管理计划
          </button>
        </div>
      </div>
    </div>
  );
}
