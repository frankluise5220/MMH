"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { Settings2, X } from "lucide-react";

type FeeRule = {
  id: string;
  feeType: string;
  direction: string;
  market?: string | null;
  stockCode?: string | null;
  rate?: number | null;
  amount?: number | null;
  minAmount?: number | null;
  currency?: string | null;
  effectiveDate?: string | null;
};

type FeeRuleListResponse = {
  ok?: boolean;
  error?: string;
  data?: { rules?: FeeRule[] };
};

type FeeRuleSaveResponse = {
  ok?: boolean;
  error?: string;
  data?: { rule?: FeeRule };
};

const FEE_TYPE_OPTIONS = [
  { value: "commission", label: "佣金" },
  { value: "stamp_tax", label: "印花税" },
  { value: "transfer_fee", label: "过户费" },
  { value: "exchange_fee", label: "经手费" },
  { value: "regulatory_fee", label: "证管费" },
  { value: "platform_fee", label: "平台费" },
  { value: "other", label: "其他费用" },
] as const;

const DIRECTION_OPTIONS = [
  { value: "both", label: "买卖都适用" },
  { value: "buy", label: "仅买入" },
  { value: "sell", label: "仅卖出" },
] as const;

const SCOPE_OPTIONS = [
  { value: "account", label: "账户通用" },
  { value: "CN", label: "A 股通用" },
  { value: "CN_SH", label: "沪市 A 股" },
  { value: "CN_SZ", label: "深市 A 股" },
  { value: "CN_BJ", label: "北交所" },
  { value: "HK", label: "港股" },
  { value: "US", label: "美股" },
] as const;

function todayDateInputValue() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatPercentRate(rate?: number | null) {
  if (rate == null || !Number.isFinite(Number(rate))) return "-";
  return `${(Number(rate) * 100).toLocaleString("zh-CN", { maximumFractionDigits: 4 })}%`;
}

function formatMoney(value?: number | null, currency = "CNY") {
  if (value == null || !Number.isFinite(Number(value))) return "-";
  return `${Number(value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

function optionLabel(options: readonly { value: string; label: string }[], value?: string | null) {
  return options.find((item) => item.value === value)?.label ?? value ?? "-";
}

export function StockFeeRuleSettingsButton({
  accountId,
  accountLabel,
  currency = "CNY",
}: {
  accountId: string;
  accountLabel: string;
  currency?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [rules, setRules] = useState<FeeRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [feeType, setFeeType] = useState("commission");
  const [direction, setDirection] = useState("both");
  const [scope, setScope] = useState("account");
  const [ratePercent, setRatePercent] = useState("");
  const [amount, setAmount] = useState("");
  const [minAmount, setMinAmount] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(todayDateInputValue);
  const [note, setNote] = useState("");

  const displayCurrency = useMemo(() => (currency?.trim() || "CNY").toUpperCase(), [currency]);

  const loadRules = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ accountId, list: "1", limit: "60" });
      const res = await fetch(`/api/v1/stocks/fee-rules?${params.toString()}`, { cache: "no-store" });
      const data = await res.json().catch(() => null) as FeeRuleListResponse | null;
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? "读取费率规则失败");
      setRules(data.data?.rules ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取费率规则失败");
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    if (open) void loadRules();
  }, [open, loadRules]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const rate = Number(ratePercent);
    const fixedAmount = Number(amount);
    if (!ratePercent.trim() && !amount.trim()) {
      setError("请填写费率或固定金额");
      return;
    }
    if (ratePercent.trim() && (!Number.isFinite(rate) || rate < 0)) {
      setError("费率格式不正确");
      return;
    }
    if (amount.trim() && (!Number.isFinite(fixedAmount) || fixedAmount < 0)) {
      setError("固定金额格式不正确");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const payload = {
        accountId,
        feeType,
        direction,
        market: scope === "account" ? undefined : scope,
        rate: ratePercent.trim() ? rate / 100 : undefined,
        amount: amount.trim() ? fixedAmount : undefined,
        minAmount: minAmount.trim() ? Number(minAmount) : undefined,
        effectiveDate,
        currency: displayCurrency,
        note: note.trim() || undefined,
      };
      const res = await fetch("/api/v1/stocks/fee-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => null) as FeeRuleSaveResponse | null;
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? "保存费率规则失败");
      setRatePercent("");
      setAmount("");
      setMinAmount("");
      setNote("");
      await loadRules();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存费率规则失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="secondary-button h-8 gap-1.5 px-3 text-xs"
        title="设置股票账户费率"
      >
        <Settings2 className="h-3.5 w-3.5" />
        账户费率
      </button>
      {open && typeof document !== "undefined" ? createPortal(
        <div className="app-modal-backdrop z-[1000]">
          <div className="app-modal-panel max-w-[min(42rem,calc(100vw-1rem))]">
            <div className="modal-header">
              <div>
                <div className="text-sm font-semibold text-slate-800">股票账户费率</div>
                <div className="mt-0.5 text-xs text-slate-500">{accountLabel}</div>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="secondary-button h-8 px-2" title="关闭">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
              <form onSubmit={submit} className="rounded-[12px] border border-slate-200 bg-slate-50/70 p-3">
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <div className="space-y-1">
                    <div className="form-label">费用类型</div>
                    <select value={feeType} onChange={(event) => setFeeType(event.target.value)} className="form-input">
                      {FEE_TYPE_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <div className="form-label">买卖方向</div>
                    <select value={direction} onChange={(event) => setDirection(event.target.value)} className="form-input">
                      {DIRECTION_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <div className="form-label">适用范围</div>
                    <select value={scope} onChange={(event) => setScope(event.target.value)} className="form-input">
                      {SCOPE_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <div className="form-label">生效日期</div>
                    <input type="date" value={effectiveDate} onChange={(event) => setEffectiveDate(event.target.value)} className="form-input" />
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
                  <div className="space-y-1">
                    <div className="form-label">费率（%）</div>
                    <input value={ratePercent} onChange={(event) => setRatePercent(event.target.value)} className="form-input" inputMode="decimal" placeholder="如 0.05" />
                  </div>
                  <div className="space-y-1">
                    <div className="form-label">固定金额</div>
                    <input value={amount} onChange={(event) => setAmount(event.target.value)} className="form-input" inputMode="decimal" placeholder="可选" />
                  </div>
                  <div className="space-y-1">
                    <div className="form-label">最低收费</div>
                    <input value={minAmount} onChange={(event) => setMinAmount(event.target.value)} className="form-input" inputMode="decimal" placeholder="可选" />
                  </div>
                  <div className="space-y-1">
                    <div className="form-label">备注</div>
                    <input value={note} onChange={(event) => setNote(event.target.value)} className="form-input" placeholder="可选" />
                  </div>
                </div>
                {error ? <div className="mt-2 text-xs text-rose-600">{error}</div> : null}
                <div className="mt-3 flex justify-end">
                  <button type="submit" disabled={saving} className="primary-button h-8 px-3 text-xs disabled:opacity-50">
                    {saving ? "保存中..." : "保存规则"}
                  </button>
                </div>
              </form>

              <div>
                <div className="mb-2 text-xs font-medium text-slate-600">当前规则</div>
                <div className="overflow-hidden rounded-[12px] border border-slate-200 bg-white">
                  {loading ? (
                    <div className="px-4 py-6 text-center text-sm text-slate-400">读取中...</div>
                  ) : rules.length > 0 ? (
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 text-xs text-slate-500">
                        <tr className="border-b border-slate-200">
                          <th className="px-3 py-2 text-left font-medium">类型</th>
                          <th className="px-3 py-2 text-left font-medium">范围</th>
                          <th className="px-3 py-2 text-left font-medium">方向</th>
                          <th className="px-3 py-2 text-right font-medium">费率</th>
                          <th className="px-3 py-2 text-right font-medium">固定/最低</th>
                          <th className="px-3 py-2 text-right font-medium">生效</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rules.map((rule) => (
                          <tr key={rule.id} className="border-b border-slate-100 last:border-b-0">
                            <td className="px-3 py-2">{optionLabel(FEE_TYPE_OPTIONS, rule.feeType)}</td>
                            <td className="px-3 py-2">{optionLabel(SCOPE_OPTIONS, rule.market ?? "account")}</td>
                            <td className="px-3 py-2">{optionLabel(DIRECTION_OPTIONS, rule.direction)}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{formatPercentRate(rule.rate)}</td>
                            <td className="px-3 py-2 text-right text-xs tabular-nums text-slate-500">
                              {formatMoney(rule.amount, rule.currency ?? displayCurrency)} / {formatMoney(rule.minAmount, rule.currency ?? displayCurrency)}
                            </td>
                            <td className="px-3 py-2 text-right text-xs tabular-nums text-slate-500">{rule.effectiveDate ?? "-"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div className="px-4 py-6 text-center text-sm text-slate-400">暂无账户费率规则</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
