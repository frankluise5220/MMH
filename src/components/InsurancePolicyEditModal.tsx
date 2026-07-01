"use client";

import { useEffect, useState } from "react";

type InsurancePolicyEditValue = {
  id: string;
  policyholderPersonId: string;
  insuredPersonId: string;
  paymentTermYears: string;
  coverageAmount: string;
};

type InsurancePolicyEditMeta = {
  name?: string | null;
  institutionName?: string | null;
  ownerName?: string | null;
};

export function InsurancePolicyEditModal({
  open,
  saving,
  value,
  meta,
  familyMemberOptions,
  onClose,
  onChange,
  onSaved,
}: {
  open: boolean;
  saving: boolean;
  value: InsurancePolicyEditValue | null;
  meta: InsurancePolicyEditMeta | null;
  familyMemberOptions?: Array<{ id: string; label: string }>;
  onClose: () => void;
  onChange?: (next: InsurancePolicyEditValue | null) => void;
  onSaved: (next: InsurancePolicyEditValue) => Promise<void>;
}) {
  const [draft, setDraft] = useState<InsurancePolicyEditValue | null>(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  if (!open || !draft || !meta) return null;

  return (
    <div className="app-modal-backdrop z-[1200]">
      <div className="app-modal-panel max-w-xl">
        <div className="modal-header">
          <div className="text-sm font-semibold text-slate-800">编辑保单</div>
          <button type="button" onClick={onClose} className="secondary-button h-8 px-2">
            关闭
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
            <div className="rounded-lg bg-slate-50/70 px-3 py-2 text-[11px] leading-5 text-slate-500">
              {[
                meta.name ? `保单：${meta.name}` : "",
                meta.institutionName ? `承保机构：${meta.institutionName}` : "",
                meta.ownerName ? `当前投保人：${meta.ownerName}` : "",
              ]
                .filter(Boolean)
                .join("  ")}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <div className="form-label">投保人</div>
                <select
                  value={draft.policyholderPersonId}
                  onChange={(event) => {
                    const next = { ...draft, policyholderPersonId: event.target.value };
                    setDraft(next);
                    onChange?.(next);
                  }}
                  className="form-input"
                >
                  <option value="">请选择</option>
                  {(familyMemberOptions ?? []).map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <div className="form-label">被保人</div>
                <select
                  value={draft.insuredPersonId}
                  onChange={(event) => {
                    const next = { ...draft, insuredPersonId: event.target.value };
                    setDraft(next);
                    onChange?.(next);
                  }}
                  className="form-input"
                >
                  <option value="">请选择</option>
                  {(familyMemberOptions ?? []).map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <div className="form-label">缴费年限</div>
                <input
                  value={draft.paymentTermYears}
                  onChange={(event) => {
                    const next = { ...draft, paymentTermYears: event.target.value };
                    setDraft(next);
                    onChange?.(next);
                  }}
                  className="form-input"
                  placeholder="例如 20"
                />
              </div>
              <div className="space-y-1">
                <div className="form-label">保额</div>
                <input
                  value={draft.coverageAmount}
                  onChange={(event) => {
                    const next = { ...draft, coverageAmount: event.target.value };
                    setDraft(next);
                    onChange?.(next);
                  }}
                  className="form-input"
                  placeholder="例如 1000000"
                />
              </div>
            </div>
          </div>

          <div className="shrink-0 border-t border-slate-100 bg-white/95 px-4 py-3">
            <div className="flex items-center justify-end gap-2">
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

export type { InsurancePolicyEditMeta, InsurancePolicyEditValue };
