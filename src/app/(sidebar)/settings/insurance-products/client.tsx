"use client";

import { useMemo, useState, type FormEvent } from "react";
import { Shield, Search, X } from "lucide-react";

import { formatMoney } from "@/lib/format";

type Option = {
  id: string;
  name: string;
  shortName?: string | null;
  label?: string;
};

type InsuranceProductRow = {
  id: string;
  name: string;
  shortName?: string | null;
  productType: string;
  accountingType: string;
  policyNo?: string | null;
  status: string;
  currency: string;
  accountId: string;
  accountName: string;
  institutionId?: string | null;
  institutionName: string;
  institutionShortName?: string | null;
  ownerGroupId?: string | null;
  ownerGroupName: string;
  insuredUserId?: string | null;
  insuredUserName: string;
  beneficiaryName?: string | null;
  startDate?: string | null;
  effectiveDate?: string | null;
  maturityDate?: string | null;
  premiumMode?: string | null;
  premiumFrequencyMonths?: number | null;
  premiumAmount?: number | null;
  paymentTermYears?: number | null;
  coverageTermYears?: number | null;
  coverageAmount?: number | null;
  cashValueEnabled?: boolean | null;
  note?: string | null;
  txCount: number;
};

type EditState = {
  id: string;
  name: string;
  shortName: string;
  productType: string;
  accountingType: string;
  policyNo: string;
  status: string;
  currency: string;
  accountId: string;
  institutionId: string;
  ownerGroupId: string;
  insuredUserId: string;
  beneficiaryName: string;
  startDate: string;
  effectiveDate: string;
  maturityDate: string;
  premiumMode: string;
  premiumFrequencyMonths: string;
  premiumAmount: string;
  paymentTermYears: string;
  coverageTermYears: string;
  coverageAmount: string;
  cashValueEnabled: boolean;
  note: string;
};

const PRODUCT_TYPE_OPTIONS = [
  { value: "savings", label: "储蓄型" },
  { value: "dividend", label: "分红型" },
  { value: "annuity", label: "年金型" },
  { value: "universal", label: "万能型" },
  { value: "investment_linked", label: "投连型" },
  { value: "critical_illness", label: "重疾险" },
  { value: "medical", label: "医疗险" },
  { value: "accident", label: "意外险" },
  { value: "term_life", label: "定期寿险" },
  { value: "whole_life", label: "终身寿险" },
  { value: "other", label: "其他" },
] as const;

const ACCOUNTING_TYPE_OPTIONS = [
  { value: "asset", label: "资产型" },
  { value: "protection", label: "保障型" },
  { value: "hybrid", label: "混合型" },
] as const;

const STATUS_OPTIONS = [
  { value: "active", label: "保障中" },
  { value: "matured", label: "已满期" },
  { value: "surrendered", label: "已退保" },
  { value: "lapsed", label: "已失效" },
] as const;

const FREQUENCY_OPTIONS = [
  { value: "", label: "未设置" },
  { value: "1", label: "每月" },
  { value: "3", label: "每季" },
  { value: "6", label: "每半年" },
  { value: "12", label: "每年" },
  { value: "999999", label: "趸交" },
] as const;

function productTypeLabel(value?: string | null) {
  return PRODUCT_TYPE_OPTIONS.find((item) => item.value === value)?.label ?? "其他";
}

function accountingTypeLabel(value?: string | null) {
  return ACCOUNTING_TYPE_OPTIONS.find((item) => item.value === value)?.label ?? "资产型";
}

function statusLabel(value?: string | null) {
  return STATUS_OPTIONS.find((item) => item.value === value)?.label ?? "保障中";
}

function frequencyLabel(value?: number | null) {
  if (value == null) return "-";
  return FREQUENCY_OPTIONS.find((item) => item.value === String(value))?.label ?? `${value} 月`;
}

function toEditState(item: InsuranceProductRow): EditState {
  return {
    id: item.id,
    name: item.name,
    shortName: item.shortName ?? "",
    productType: item.productType || "other",
    accountingType: item.accountingType || "asset",
    policyNo: item.policyNo ?? "",
    status: item.status || "active",
    currency: item.currency || "CNY",
    accountId: item.accountId,
    institutionId: item.institutionId ?? "",
    ownerGroupId: item.ownerGroupId ?? "",
    insuredUserId: item.insuredUserId ?? "",
    beneficiaryName: item.beneficiaryName ?? "",
    startDate: item.startDate ?? "",
    effectiveDate: item.effectiveDate ?? "",
    maturityDate: item.maturityDate ?? "",
    premiumMode: item.premiumMode ?? "",
    premiumFrequencyMonths: item.premiumFrequencyMonths != null ? String(item.premiumFrequencyMonths) : "",
    premiumAmount: item.premiumAmount != null ? String(item.premiumAmount) : "",
    paymentTermYears: item.paymentTermYears != null ? String(item.paymentTermYears) : "",
    coverageTermYears: item.coverageTermYears != null ? String(item.coverageTermYears) : "",
    coverageAmount: item.coverageAmount != null ? String(item.coverageAmount) : "",
    cashValueEnabled: item.cashValueEnabled !== false,
    note: item.note ?? "",
  };
}

function mapApiProduct(item: any, previous?: InsuranceProductRow): InsuranceProductRow {
  return {
    id: String(item.id),
    name: String(item.name ?? ""),
    shortName: item.shortName ? String(item.shortName) : null,
    productType: String(item.productType ?? "other"),
    accountingType: String(item.accountingType ?? "asset"),
    policyNo: item.policyNo ? String(item.policyNo) : null,
    status: String(item.status ?? "active"),
    currency: String(item.currency ?? "CNY"),
    accountId: String(item.accountId ?? ""),
    accountName: String(item.accountName ?? previous?.accountName ?? ""),
    institutionId: item.institutionId ? String(item.institutionId) : null,
    institutionName: String(item.institutionName ?? previous?.institutionName ?? ""),
    institutionShortName: item.institutionShortName ? String(item.institutionShortName) : null,
    ownerGroupId: item.ownerGroupId ? String(item.ownerGroupId) : null,
    ownerGroupName: String(item.ownerGroupName ?? previous?.ownerGroupName ?? ""),
    insuredUserId: item.insuredUserId ? String(item.insuredUserId) : null,
    insuredUserName: String(item.insuredUserName ?? previous?.insuredUserName ?? ""),
    beneficiaryName: item.beneficiaryName ? String(item.beneficiaryName) : null,
    startDate: item.startDate ? String(item.startDate) : null,
    effectiveDate: item.effectiveDate ? String(item.effectiveDate) : null,
    maturityDate: item.maturityDate ? String(item.maturityDate) : null,
    premiumMode: item.premiumMode ? String(item.premiumMode) : null,
    premiumFrequencyMonths: item.premiumFrequencyMonths != null ? Number(item.premiumFrequencyMonths) : null,
    premiumAmount: item.premiumAmount != null ? Number(item.premiumAmount) : null,
    paymentTermYears: item.paymentTermYears != null ? Number(item.paymentTermYears) : null,
    coverageTermYears: item.coverageTermYears != null ? Number(item.coverageTermYears) : null,
    coverageAmount: item.coverageAmount != null ? Number(item.coverageAmount) : null,
    cashValueEnabled: item.cashValueEnabled != null ? Boolean(item.cashValueEnabled) : true,
    note: item.note ? String(item.note) : null,
    txCount: previous?.txCount ?? 0,
  };
}

export function SettingsInsuranceProductsClient({
  initialProducts,
  accounts,
  institutions,
  ownerGroups,
  users,
}: {
  initialProducts: InsuranceProductRow[];
  accounts: Option[];
  institutions: Option[];
  ownerGroups: Option[];
  users: Option[];
}) {
  const [products, setProducts] = useState(initialProducts);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [onlyWithRecords, setOnlyWithRecords] = useState(false);
  const [editing, setEditing] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);

  const filteredProducts = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return products
      .filter((item) => statusFilter === "all" || item.status === statusFilter)
      .filter((item) => !onlyWithRecords || item.txCount > 0)
      .filter((item) => {
        if (!keyword) return true;
        return [
          item.name,
          item.shortName,
          item.policyNo,
          item.institutionName,
          item.ownerGroupName,
          item.insuredUserName,
          item.accountName,
        ].some((text) => String(text ?? "").toLowerCase().includes(keyword));
      });
  }, [onlyWithRecords, products, query, statusFilter]);

  const activeCount = products.filter((item) => item.status === "active").length;
  const orphanCount = products.filter((item) => item.txCount === 0).length;

  async function onSave(event: FormEvent) {
    event.preventDefault();
    if (!editing || saving) return;
    if (!editing.name.trim()) {
      window.alert("请输入保险产品名称");
      return;
    }
    if (!editing.ownerGroupId) {
      window.alert("请选择投保人");
      return;
    }
    if (!editing.institutionId) {
      window.alert("请选择承保机构");
      return;
    }

    setSaving(true);
    try {
      const response = await fetch("/api/v1/insurance-products", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...editing,
          shortName: editing.shortName.trim() || null,
          policyNo: editing.policyNo.trim() || null,
          insuredUserId: editing.insuredUserId || null,
          beneficiaryName: editing.beneficiaryName.trim() || null,
          premiumFrequencyMonths: editing.premiumFrequencyMonths || null,
          premiumAmount: editing.premiumAmount || null,
          paymentTermYears: editing.paymentTermYears || null,
          coverageTermYears: editing.coverageTermYears || null,
          coverageAmount: editing.coverageAmount || null,
          startDate: editing.startDate || null,
          effectiveDate: editing.effectiveDate || null,
          maturityDate: editing.maturityDate || null,
          note: editing.note.trim() || null,
        }),
      });
      const data = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string; insuranceProduct?: any }
        | null;
      if (!response.ok || !data?.ok || !data.insuranceProduct) {
        throw new Error(data?.error || "保存保险产品失败");
      }
      setProducts((prev) => prev.map((item) =>
        item.id === editing.id ? mapApiProduct(data.insuranceProduct, item) : item,
      ));
      setEditing(null);
      window.dispatchEvent(new Event("mmh:fund:refresh"));
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "保存保险产品失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="panel-surface overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <Shield className="h-4 w-4 text-cyan-600" />
              保险产品库
            </div>
            <div className="mt-1 text-xs text-slate-500">
              维护产品本身的类型、状态、承保机构、投保人和保障信息。删除交易后的空产品只在这里保留，不再占用持仓表。
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 text-right text-xs">
            <Summary label="全部" value={products.length} />
            <Summary label="保障中" value={activeCount} />
            <Summary label="无记录" value={orphanCount} />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-3">
          <div className="relative min-w-[240px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索产品、保单号、机构、投保人"
              className="form-input h-9 pl-8 text-sm"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
            className="form-input h-9 w-32 text-sm"
            title="状态筛选"
            aria-label="状态筛选"
          >
            <option value="all">全部状态</option>
            {STATUS_OPTIONS.map((item) => (
              <option key={item.value} value={item.value}>{item.label}</option>
            ))}
          </select>
          <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={onlyWithRecords}
              onChange={(event) => setOnlyWithRecords(event.target.checked)}
              className="h-3.5 w-3.5 rounded border-slate-300"
            />
            仅有交易记录
          </label>
        </div>

        <div className="overflow-auto">
          <table className="w-full min-w-[1180px] border-separate border-spacing-0">
            <thead className="sticky top-0 z-10 bg-slate-50">
              <tr>
                <Th>保险产品</Th>
                <Th>状态</Th>
                <Th>承保机构</Th>
                <Th>投保人</Th>
                <Th>被保险人</Th>
                <Th align="right">保额</Th>
                <Th align="right">保费</Th>
                <Th>缴费</Th>
                <Th>账户</Th>
                <Th align="right">记录</Th>
                <Th align="right">操作</Th>
              </tr>
            </thead>
            <tbody className="text-sm">
              {filteredProducts.length > 0 ? filteredProducts.map((item) => (
                <tr key={item.id} className={item.txCount === 0 ? "bg-amber-50/30 hover:bg-amber-50/60" : "hover:bg-slate-50"}>
                  <Td>
                    <div className="min-w-0">
                      <div className="truncate font-medium text-slate-800" title={item.name}>{item.name}</div>
                      <div className="mt-0.5 flex flex-wrap gap-1.5 text-[11px] text-slate-400">
                        <span>{productTypeLabel(item.productType)}</span>
                        <span>{accountingTypeLabel(item.accountingType)}</span>
                        {item.policyNo ? <span>保单 {item.policyNo}</span> : null}
                      </div>
                    </div>
                  </Td>
                  <Td>
                    <span className={`rounded px-1.5 py-0.5 text-[11px] ${
                      item.status === "active"
                        ? "bg-emerald-50 text-emerald-700"
                        : "bg-slate-100 text-slate-500"
                    }`}>
                      {statusLabel(item.status)}
                    </span>
                  </Td>
                  <Td>{item.institutionShortName || item.institutionName || "-"}</Td>
                  <Td>{item.ownerGroupName || "-"}</Td>
                  <Td>{item.insuredUserName || "-"}</Td>
                  <Td align="right">{item.coverageAmount != null ? formatMoney(item.coverageAmount) : "-"}</Td>
                  <Td align="right">{item.premiumAmount != null ? formatMoney(item.premiumAmount) : "-"}</Td>
                  <Td>{frequencyLabel(item.premiumFrequencyMonths)}</Td>
                  <Td>{item.accountName || "-"}</Td>
                  <Td align="right">
                    <span className={item.txCount === 0 ? "text-amber-700" : "text-slate-600"}>{item.txCount}</span>
                  </Td>
                  <Td align="right">
                    <button
                      type="button"
                      onClick={() => setEditing(toEditState(item))}
                      className="secondary-button h-8 px-2 text-xs"
                    >
                      编辑
                    </button>
                  </Td>
                </tr>
              )) : (
                <tr>
                  <td colSpan={11} className="px-4 py-10 text-center text-sm text-slate-400">暂无保险产品</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {editing ? (
        <div className="fixed inset-0 z-[1000] flex items-stretch justify-center overflow-hidden bg-slate-950/28 p-2 backdrop-blur-[2px] sm:items-center sm:p-4">
          <div className="modal-surface flex h-full w-full max-w-[min(48rem,calc(100vw-1rem))] flex-col overflow-hidden sm:h-auto sm:max-h-[calc(100dvh-2rem)]">
            <div className="modal-header shrink-0">
              <div className="text-sm font-semibold text-slate-800">编辑保险产品</div>
              <button type="button" onClick={() => setEditing(null)} className="secondary-button h-8 px-2">
                <X className="h-4 w-4" />
              </button>
            </div>

            <form className="flex min-h-0 flex-1 flex-col" onSubmit={onSave}>
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 sm:p-4">
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <Field label="产品名称">
                    <input value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} className="form-input" />
                  </Field>
                  <Field label="简称">
                    <input value={editing.shortName} onChange={(event) => setEditing({ ...editing, shortName: event.target.value })} className="form-input" />
                  </Field>
                  <Field label="产品类型">
                    <select value={editing.productType} onChange={(event) => setEditing({ ...editing, productType: event.target.value })} className="form-input">
                      {PRODUCT_TYPE_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                    </select>
                  </Field>
                  <Field label="显示口径">
                    <select value={editing.accountingType} onChange={(event) => setEditing({ ...editing, accountingType: event.target.value })} className="form-input">
                      {ACCOUNTING_TYPE_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                    </select>
                  </Field>
                  <Field label="状态">
                    <select value={editing.status} onChange={(event) => setEditing({ ...editing, status: event.target.value })} className="form-input">
                      {STATUS_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                    </select>
                  </Field>
                  <Field label="保单号">
                    <input value={editing.policyNo} onChange={(event) => setEditing({ ...editing, policyNo: event.target.value })} className="form-input" />
                  </Field>
                  <Field label="承保机构">
                    <select value={editing.institutionId} onChange={(event) => setEditing({ ...editing, institutionId: event.target.value })} className="form-input">
                      <option value="">请选择</option>
                      {institutions.map((item) => <option key={item.id} value={item.id}>{item.label || item.name}</option>)}
                    </select>
                  </Field>
                  <Field label="投保人">
                    <select value={editing.ownerGroupId} onChange={(event) => setEditing({ ...editing, ownerGroupId: event.target.value })} className="form-input">
                      <option value="">请选择</option>
                      {ownerGroups.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                    </select>
                  </Field>
                  <Field label="被保险人">
                    <select value={editing.insuredUserId} onChange={(event) => setEditing({ ...editing, insuredUserId: event.target.value })} className="form-input">
                      <option value="">未设置</option>
                      {users.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                    </select>
                  </Field>
                  <Field label="受益人">
                    <input value={editing.beneficiaryName} onChange={(event) => setEditing({ ...editing, beneficiaryName: event.target.value })} className="form-input" />
                  </Field>
                  <Field label="缴费频率">
                    <select value={editing.premiumFrequencyMonths} onChange={(event) => setEditing({ ...editing, premiumFrequencyMonths: event.target.value })} className="form-input">
                      {FREQUENCY_OPTIONS.map((item) => <option key={item.value || "empty"} value={item.value}>{item.label}</option>)}
                    </select>
                  </Field>
                  <Field label="每期保费">
                    <input inputMode="decimal" value={editing.premiumAmount} onChange={(event) => setEditing({ ...editing, premiumAmount: event.target.value })} className="form-input" />
                  </Field>
                  <Field label="缴费年限">
                    <input inputMode="decimal" value={editing.paymentTermYears} onChange={(event) => setEditing({ ...editing, paymentTermYears: event.target.value })} className="form-input" />
                  </Field>
                  <Field label="保障年限">
                    <input inputMode="decimal" value={editing.coverageTermYears} onChange={(event) => setEditing({ ...editing, coverageTermYears: event.target.value })} className="form-input" />
                  </Field>
                  <Field label="保额">
                    <input inputMode="decimal" value={editing.coverageAmount} onChange={(event) => setEditing({ ...editing, coverageAmount: event.target.value })} className="form-input" />
                  </Field>
                  <Field label="保险账户">
                    <select value={editing.accountId} onChange={(event) => setEditing({ ...editing, accountId: event.target.value })} className="form-input">
                      {accounts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                    </select>
                  </Field>
                  <Field label="开始投保">
                    <input type="date" value={editing.startDate} onChange={(event) => setEditing({ ...editing, startDate: event.target.value })} className="form-input" />
                  </Field>
                  <Field label="生效日期">
                    <input type="date" value={editing.effectiveDate} onChange={(event) => setEditing({ ...editing, effectiveDate: event.target.value })} className="form-input" />
                  </Field>
                  <Field label="满期日期">
                    <input type="date" value={editing.maturityDate} onChange={(event) => setEditing({ ...editing, maturityDate: event.target.value })} className="form-input" />
                  </Field>
                  <label className="flex items-center gap-2 pt-6 text-xs text-slate-600">
                    <input
                      type="checkbox"
                      checked={editing.cashValueEnabled}
                      onChange={(event) => setEditing({ ...editing, cashValueEnabled: event.target.checked })}
                      className="h-3.5 w-3.5 rounded border-slate-300"
                    />
                    参与现金价值/余额显示
                  </label>
                </div>
                <Field label="备注">
                  <textarea
                    value={editing.note}
                    onChange={(event) => setEditing({ ...editing, note: event.target.value })}
                    className="form-input min-h-24 resize-y"
                  />
                </Field>
              </div>

              <div className="shrink-0 border-t border-slate-100 bg-white/95 px-3 py-3 sm:px-4">
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => setEditing(null)} className="secondary-button h-9 px-4">
                    取消
                  </button>
                  <button type="submit" disabled={saving} className="primary-button h-9 px-4 disabled:opacity-50">
                    {saving ? "保存中..." : "保存产品"}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Summary({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
      <div className="text-[11px] text-slate-400">{label}</div>
      <div className="mt-0.5 text-sm font-semibold tabular-nums text-slate-800">{value}</div>
    </div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: "right" }) {
  return (
    <th className={`border-b border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 ${align === "right" ? "text-right" : "text-left"}`}>
      {children}
    </th>
  );
}

function Td({ children, align }: { children: React.ReactNode; align?: "right" }) {
  return (
    <td className={`border-b border-slate-100 px-3 py-2 text-xs text-slate-600 ${align === "right" ? "text-right tabular-nums" : "text-left"}`}>
      {children}
    </td>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="space-y-1">
      <div className="form-label">{label}</div>
      {children}
    </label>
  );
}
