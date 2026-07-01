"use client";

import { useMemo, useState, type FormEvent } from "react";
import { Search, Shield, Trash2, X } from "lucide-react";

type Option = {
  id: string;
  name: string;
  shortName?: string | null;
  label?: string;
};

type InsuranceProductMasterRow = {
  id: string;
  name: string;
  shortName?: string | null;
  productType: string;
  accountingType: string;
  currency: string;
  institutionId: string;
  institutionName: string;
  institutionShortName?: string | null;
  note?: string | null;
  policyCount: number;
};

type EditState = {
  id: string;
  name: string;
  shortName: string;
  productType: string;
  accountingType: string;
  currency: string;
  institutionId: string;
  note: string;
};

type DeleteState = {
  id: string;
  name: string;
  policyCount: number;
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

function productTypeLabel(value?: string | null) {
  return PRODUCT_TYPE_OPTIONS.find((item) => item.value === value)?.label ?? "其他";
}

function accountingTypeLabel(value?: string | null) {
  return ACCOUNTING_TYPE_OPTIONS.find((item) => item.value === value)?.label ?? "资产型";
}

function toEditState(item: InsuranceProductMasterRow): EditState {
  return {
    id: item.id,
    name: item.name,
    shortName: item.shortName ?? "",
    productType: item.productType,
    accountingType: item.accountingType,
    currency: item.currency,
    institutionId: item.institutionId,
    note: item.note ?? "",
  };
}

function mapApiProductMaster(
  item: Record<string, unknown>,
  previous?: InsuranceProductMasterRow,
): InsuranceProductMasterRow {
  return {
    id: String(item.id ?? previous?.id ?? ""),
    name: String(item.name ?? previous?.name ?? ""),
    shortName: item.shortName ? String(item.shortName) : null,
    productType: String(item.productType ?? previous?.productType ?? "other"),
    accountingType: String(item.accountingType ?? previous?.accountingType ?? "asset"),
    currency: String(item.currency ?? previous?.currency ?? "CNY"),
    institutionId: String(item.institutionId ?? previous?.institutionId ?? ""),
    institutionName: String(item.institutionName ?? previous?.institutionName ?? ""),
    institutionShortName: item.institutionShortName ? String(item.institutionShortName) : null,
    note: item.note ? String(item.note) : null,
    policyCount:
      typeof item.policyCount === "number"
        ? item.policyCount
        : previous?.policyCount ?? 0,
  };
}

export function SettingsInsuranceProductsClient({
  initialProducts,
  institutions,
}: {
  initialProducts: InsuranceProductMasterRow[];
  institutions: Option[];
}) {
  const [products, setProducts] = useState(initialProducts);
  const [query, setQuery] = useState("");
  const [productTypeFilter, setProductTypeFilter] = useState("all");
  const [editing, setEditing] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteState | null>(null);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteCascade, setDeleteCascade] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);

  const filteredProducts = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return products
      .filter((item) => productTypeFilter === "all" || item.productType === productTypeFilter)
      .filter((item) => {
        if (!keyword) return true;
        return [
          item.name,
          item.shortName,
          item.institutionName,
          item.institutionShortName,
          item.note,
        ].some((text) => String(text ?? "").toLowerCase().includes(keyword));
      });
  }, [productTypeFilter, products, query]);

  const linkedCount = products.filter((item) => item.policyCount > 0).length;

  async function onSave(event: FormEvent) {
    event.preventDefault();
    if (!editing || saving) return;
    if (!editing.name.trim()) {
      window.alert("请输入保险产品名称");
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
          mode: "master",
          shortName: editing.shortName.trim() || null,
          note: editing.note.trim() || null,
        }),
      });
      const data = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string; productMaster?: Record<string, unknown> }
        | null;
      if (!response.ok || !data?.ok || !data.productMaster) {
        throw new Error(data?.error || "保存保险产品失败");
      }
      const productMaster = data.productMaster;
      setProducts((prev) =>
        prev.map((item) =>
          item.id === editing.id && productMaster
            ? mapApiProductMaster(productMaster, item)
            : item,
        ),
      );
      setEditing(null);
      window.dispatchEvent(new Event("mmh:fund:refresh"));
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "保存保险产品失败");
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setDeleteError("");
    try {
      const response = await fetch(
        `/api/v1/insurance-products?id=${encodeURIComponent(deleteTarget.id)}&mode=master`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            password: deletePassword,
            cascade: deleteCascade,
          }),
        },
      );
      const data = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string }
        | null;
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || "删除保险产品失败");
      }
      setProducts((prev) => prev.filter((item) => item.id !== deleteTarget.id));
      if (editing?.id === deleteTarget.id) {
        setEditing(null);
      }
      setDeleteTarget(null);
      setDeletePassword("");
      setDeleteCascade(false);
      window.dispatchEvent(new Event("mmh:fund:refresh"));
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "删除保险产品失败");
    } finally {
      setDeleting(false);
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
              这里只维护产品主数据，不保存投保人、被保人、受益人等保单信息。
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 text-right text-xs">
            <Summary label="全部" value={products.length} />
            <Summary label="已关联" value={linkedCount} />
            <Summary label="未关联" value={products.length - linkedCount} />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-3">
          <div className="relative min-w-[240px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索产品名称、简称、承保机构"
              className="form-input h-9 pl-8 text-sm"
            />
          </div>
          <select
            value={productTypeFilter}
            onChange={(event) => setProductTypeFilter(event.target.value)}
            className="form-input h-9 w-36 text-sm"
            title="产品类型筛选"
            aria-label="产品类型筛选"
          >
            <option value="all">全部类型</option>
            {PRODUCT_TYPE_OPTIONS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </div>

        <div className="overflow-auto">
          <table className="w-full min-w-[920px] border-separate border-spacing-0">
            <thead className="sticky top-0 z-10 bg-slate-50">
              <tr>
                <Th>保险产品</Th>
                <Th>产品类型</Th>
                <Th>显示口径</Th>
                <Th>承保机构</Th>
                <Th>币种</Th>
                <Th align="right">关联保单</Th>
                <Th>备注</Th>
                <Th align="right">操作</Th>
              </tr>
            </thead>
            <tbody className="text-sm">
              {filteredProducts.length > 0 ? (
                filteredProducts.map((item) => (
                  <tr key={item.id} className="hover:bg-slate-50">
                    <Td>
                      <div className="min-w-0">
                        <div className="truncate font-medium text-slate-800" title={item.name}>
                          {item.name}
                        </div>
                        {item.shortName ? (
                          <div className="mt-0.5 text-[11px] text-slate-400">{item.shortName}</div>
                        ) : null}
                      </div>
                    </Td>
                    <Td>{productTypeLabel(item.productType)}</Td>
                    <Td>{accountingTypeLabel(item.accountingType)}</Td>
                    <Td>{item.institutionShortName || item.institutionName || "-"}</Td>
                    <Td>{item.currency}</Td>
                    <Td align="right">{item.policyCount}</Td>
                    <Td>
                      <div className="line-clamp-2 max-w-[20rem] text-xs text-slate-500">
                        {item.note || "-"}
                      </div>
                    </Td>
                    <Td align="right">
                      <div className="flex justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => setEditing(toEditState(item))}
                          className="secondary-button h-8 px-2 text-xs"
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setDeleteError("");
                            setDeletePassword("");
                            setDeleteCascade(false);
                            setDeleteTarget({
                              id: item.id,
                              name: item.name,
                              policyCount: item.policyCount,
                            });
                          }}
                          className="secondary-button h-8 px-2 text-xs"
                          title="删除保险产品"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </Td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-sm text-slate-400">
                    暂无保险产品
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {editing ? (
        <div className="app-modal-backdrop z-[1000]">
          <div className="app-modal-panel max-w-[min(42rem,calc(100vw-1rem))]">
            <div className="modal-header shrink-0">
              <div className="text-sm font-semibold text-slate-800">编辑保险产品</div>
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="secondary-button h-8 px-2"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form className="flex min-h-0 flex-1 flex-col" onSubmit={onSave}>
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 sm:p-4">
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <Field label="产品名称">
                    <input
                      value={editing.name}
                      onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                      className="form-input"
                    />
                  </Field>
                  <Field label="简称">
                    <input
                      value={editing.shortName}
                      onChange={(event) => setEditing({ ...editing, shortName: event.target.value })}
                      className="form-input"
                    />
                  </Field>
                  <Field label="产品类型">
                    <select
                      value={editing.productType}
                      onChange={(event) => setEditing({ ...editing, productType: event.target.value })}
                      className="form-input"
                    >
                      {PRODUCT_TYPE_OPTIONS.map((item) => (
                        <option key={item.value} value={item.value}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="显示口径">
                    <select
                      value={editing.accountingType}
                      onChange={(event) =>
                        setEditing({ ...editing, accountingType: event.target.value })
                      }
                      className="form-input"
                    >
                      {ACCOUNTING_TYPE_OPTIONS.map((item) => (
                        <option key={item.value} value={item.value}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="承保机构">
                    <select
                      value={editing.institutionId}
                      onChange={(event) => setEditing({ ...editing, institutionId: event.target.value })}
                      className="form-input"
                    >
                      <option value="">请选择</option>
                      {institutions.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.label || item.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="币种">
                    <input
                      value={editing.currency}
                      onChange={(event) => setEditing({ ...editing, currency: event.target.value.toUpperCase() })}
                      className="form-input"
                    />
                  </Field>
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
                  <button
                    type="button"
                    onClick={() => setEditing(null)}
                    className="secondary-button h-9 px-4"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="primary-button h-9 px-4 disabled:opacity-50"
                  >
                    {saving ? "保存中..." : "保存产品"}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {deleteTarget ? (
        <div
          className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/30 p-4 backdrop-blur-[1px]"
          onMouseDown={() => {
            if (deleting) return;
            setDeleteTarget(null);
            setDeleteError("");
          }}
        >
          <div
            className="w-[360px] max-w-[calc(100vw-2rem)] rounded-xl border border-slate-200 bg-white p-4 shadow-xl"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="text-sm font-semibold text-slate-800">确认删除保险产品</div>
            <div className="mt-1 text-xs leading-5 text-slate-500">
              产品“{deleteTarget.name}”
              {deleteTarget.policyCount > 0
                ? ` 已关联 ${deleteTarget.policyCount} 个保单。勾选后会一并删除关联保单、交易记录与计划任务。`
                : " 当前没有关联保单。"}
            </div>
            {deleteTarget.policyCount > 0 ? (
              <label className="mt-3 flex items-start gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={deleteCascade}
                  onChange={(event) => setDeleteCascade(event.target.checked)}
                  className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300"
                />
                <span>同时删除关联保单、交易记录和计划任务</span>
              </label>
            ) : null}
            <input
              type="password"
              value={deletePassword}
              onChange={(event) => {
                setDeletePassword(event.target.value);
                setDeleteError("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void confirmDelete();
                }
              }}
              placeholder="输入密码确认"
              autoFocus
              className="mt-3 h-9 w-full rounded-md border border-slate-200 px-3 text-sm outline-none focus:border-blue-400"
            />
            {deleteError ? <div className="mt-1 text-xs text-red-500">{deleteError}</div> : null}
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  if (deleting) return;
                  setDeleteTarget(null);
                  setDeleteError("");
                }}
                className="h-8 rounded-md border border-slate-200 bg-white px-3 text-xs text-slate-600 hover:bg-slate-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void confirmDelete()}
                disabled={deleting}
                className="h-8 rounded-md bg-red-600 px-3 text-xs text-white hover:bg-red-700 disabled:opacity-50"
              >
                {deleting ? "删除中..." : "确认删除"}
              </button>
            </div>
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
    <th
      className={`border-b border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

function Td({ children, align }: { children: React.ReactNode; align?: "right" }) {
  return (
    <td
      className={`border-b border-slate-100 px-3 py-2 text-xs text-slate-600 ${
        align === "right" ? "text-right tabular-nums" : "text-left"
      }`}
    >
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
