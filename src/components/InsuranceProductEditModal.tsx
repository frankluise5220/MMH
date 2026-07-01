"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";

type InsuranceProductEditValue = {
  id: string;
  name: string;
  shortName: string;
  productType: string;
  accountingType: string;
  currency: string;
  institutionId: string;
  note: string;
};

type InsuranceProductEditOption = {
  id: string;
  label: string;
  shortName?: string | null;
};

type InsuranceProductEditInstitution = {
  id: string;
  label: string;
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

function toLabel(value?: string | null) {
  return PRODUCT_TYPE_OPTIONS.find((item) => item.value === value)?.label ?? "其他";
}

export function InsuranceProductEditModal({
  open,
  saving,
  value,
  institutions,
  products,
  onClose,
  onChange,
  onSaved,
}: {
  open: boolean;
  saving: boolean;
  value: InsuranceProductEditValue | null;
  institutions: InsuranceProductEditInstitution[];
  products: InsuranceProductEditOption[];
  onClose: () => void;
  onChange: (next: InsuranceProductEditValue) => void;
  onSaved: (next: InsuranceProductEditValue) => Promise<void>;
}) {
  const [draft, setDraft] = useState<InsuranceProductEditValue | null>(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  if (!open || !draft) return null;

  return (
    <div className="app-modal-backdrop z-[1200]">
      <div className="app-modal-panel max-w-2xl">
        <div className="modal-header">
          <div className="text-sm font-semibold text-slate-800">编辑保险产品</div>
          <button type="button" onClick={onClose} className="secondary-button h-8 px-2">
            <X className="h-4 w-4" />
          </button>
        </div>

        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void onSaved(draft);
          }}
        >
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <div className="form-label">保险产品</div>
                <select
                  value={draft.id}
                  onChange={(event) => {
                    const matched = products.find((item) => item.id === event.target.value);
                    if (!matched) return;
                    const next = {
                      ...draft,
                      id: matched.id,
                      name: matched.label,
                      shortName: matched.shortName ?? "",
                    };
                    setDraft(next);
                    onChange(next);
                  }}
                  className="form-input"
                >
                  {products.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <div className="form-label">承保机构</div>
                <select
                  value={draft.institutionId}
                  onChange={(event) => {
                    const next = { ...draft, institutionId: event.target.value };
                    setDraft(next);
                    onChange(next);
                  }}
                  className="form-input"
                >
                  {institutions.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <div className="form-label">产品名称</div>
                <input
                  value={draft.name}
                  onChange={(event) => {
                    const next = { ...draft, name: event.target.value };
                    setDraft(next);
                    onChange(next);
                  }}
                  className="form-input"
                />
              </div>
              <div className="space-y-1">
                <div className="form-label">简称</div>
                <input
                  value={draft.shortName}
                  onChange={(event) => {
                    const next = { ...draft, shortName: event.target.value };
                    setDraft(next);
                    onChange(next);
                  }}
                  className="form-input"
                />
              </div>
              <div className="space-y-1">
                <div className="form-label">产品类型</div>
                <select
                  value={draft.productType}
                  onChange={(event) => {
                    const next = { ...draft, productType: event.target.value };
                    setDraft(next);
                    onChange(next);
                  }}
                  className="form-input"
                >
                  {PRODUCT_TYPE_OPTIONS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <div className="form-label">显示口径</div>
                <select
                  value={draft.accountingType}
                  onChange={(event) => {
                    const next = { ...draft, accountingType: event.target.value };
                    setDraft(next);
                    onChange(next);
                  }}
                  className="form-input"
                >
                  {ACCOUNTING_TYPE_OPTIONS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <div className="form-label">币种</div>
                <input
                  value={draft.currency}
                  onChange={(event) => {
                    const next = { ...draft, currency: event.target.value.toUpperCase() };
                    setDraft(next);
                    onChange(next);
                  }}
                  className="form-input"
                />
              </div>
            </div>

            <div className="space-y-1">
              <div className="form-label">备注</div>
              <textarea
                value={draft.note}
                onChange={(event) => {
                  const next = { ...draft, note: event.target.value };
                  setDraft(next);
                  onChange(next);
                }}
                className="form-input min-h-24 resize-y"
              />
            </div>
            <div className="text-xs text-slate-500">
              {draft.name ? `${draft.name} · ${toLabel(draft.productType)}` : "编辑保险产品主数据"}
            </div>
          </div>

          <div className="shrink-0 border-t border-slate-100 bg-white/95 px-4 py-3">
            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} className="secondary-button h-9 px-4">
                取消
              </button>
              <button
                type="submit"
                disabled={saving}
                className="primary-button h-9 px-4 text-white disabled:opacity-50"
              >
                {saving ? "保存中..." : "保存"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

export type { InsuranceProductEditInstitution, InsuranceProductEditOption, InsuranceProductEditValue };
