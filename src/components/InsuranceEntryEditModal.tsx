"use client";

import { useEffect, useMemo, useState } from "react";

import { DateStepper } from "./DateStepper";
import { CalcInput } from "./CalcInput";
import { SmartSelect, type SmartSelectOption } from "./SmartSelect";
import { useAccountSSFilter } from "./accountSSFilter";
import { NestedAddModal } from "./EntityCreateForm";
import { kindLabel } from "@/lib/account-kinds";

type InsuranceEntryEditValue = {
  id: string;
  date: string;
  amount: string;
  cashAccountId: string;
  coverageAmount: string;
  paymentTermYears: string;
  note: string;
  fundSubtype: string;
  fundProductType: string;
  insuranceProductId: string;
  insuranceProductName: string;
};

export type { InsuranceEntryEditValue };

type AccountOption = {
  id: string;
  label: string;
  icon?: string;
  subLabel?: string;
};

type NestedFieldData = Record<string, Array<{ id: string; name: string; type?: string }>>;

function parseOptionalNumber(input: string) {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return null;
  const value = Number(trimmed.replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

export function InsuranceEntryEditModal({
  open,
  value,
  cashAccounts,
  cashAccountSSOptions,
  nestedFieldData,
  onClose,
  onSaved,
}: {
  open: boolean;
  value: InsuranceEntryEditValue | null;
  cashAccounts?: AccountOption[];
  cashAccountSSOptions?: SmartSelectOption[];
  nestedFieldData?: NestedFieldData;
  onClose: () => void;
  onSaved: (next: InsuranceEntryEditValue) => Promise<void>;
}) {
  const [draft, setDraft] = useState<InsuranceEntryEditValue | null>(value);
  const [saving, setSaving] = useState(false);
  const [cashAccountList, setCashAccountList] = useState(cashAccounts ?? []);
  const [localCashSSOpts, setLocalCashSSOpts] = useState(cashAccountSSOptions);
  const [nestedEntityType, setNestedEntityType] = useState<"cash-account" | null>(null);

  useEffect(() => {
    setDraft(value);
  }, [value]);
  useEffect(() => setCashAccountList(cashAccounts ?? []), [cashAccounts]);
  useEffect(() => setLocalCashSSOpts(cashAccountSSOptions), [cashAccountSSOptions]);

  const {
    ownerFilterLabel: cashOwnerFilterLabel,
    cycleOwnerFilter: cycleCashOwnerFilter,
    filteredOptions: cashFiltered,
  } = useAccountSSFilter(localCashSSOpts);

  const cashOptions = cashFiltered ?? cashAccountList;

  if (!open || !draft) return null;

  async function handleSave() {
    const currentDraft = draft;
    if (!currentDraft) return;

    const amountValue = parseOptionalNumber(currentDraft.amount);
    if (amountValue == null || amountValue <= 0) {
      window.alert("请输入正确金额");
      return;
    }

    setSaving(true);
    try {
      const response = await fetch("/api/v1/transactions/detail", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: currentDraft.id,
          type: "investment",
          date: currentDraft.date,
          amount: amountValue,
          cashAccountId: currentDraft.cashAccountId,
          fundSubtype: currentDraft.fundSubtype,
          fundProductType: currentDraft.fundProductType,
          source: "insurance",
          insuranceProductId: currentDraft.insuranceProductId,
          note: currentDraft.note,
          coverageAmount: parseOptionalNumber(currentDraft.coverageAmount),
          paymentTermYears: parseOptionalNumber(currentDraft.paymentTermYears),
        }),
      });
      const data = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string }
        | null;
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || "保存失败");
      }
      await onSaved(currentDraft);
      onClose();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="app-modal-backdrop z-[1200]">
      <div className="app-modal-panel max-w-xl">
        <div className="modal-header">
          <div className="text-sm font-semibold text-slate-800">编辑投保记录</div>
          <button type="button" onClick={onClose} className="secondary-button h-8 px-2">
            关闭
          </button>
        </div>

        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            handleSave();
          }}
        >
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
            <div className="space-y-1">
              <div className="form-label">保险产品</div>
              <div className="form-input flex h-9 items-center bg-slate-50 text-sm text-slate-600">
                {draft.insuranceProductName || "-"}
              </div>
            </div>

            {/* 日期 + 金额 */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <div className="form-label">日期</div>
                <DateStepper
                  value={draft.date}
                  onChange={(next) => setDraft({ ...draft, date: next })}
                />
              </div>
              <div className="space-y-1">
                <div className="form-label">金额</div>
                <CalcInput
                  value={draft.amount}
                  onChange={(val) => setDraft({ ...draft, amount: val })}
                  placeholder="0.00"
                  label="金额"
                  precision={2}
                />
              </div>
            </div>

            {/* 资金来源 */}
            <div className="space-y-1">
              <div className="form-label">资金来源</div>
              <SmartSelect
                mode="single"
                value={draft.cashAccountId}
                onChange={(id) => setDraft({ ...draft, cashAccountId: id })}
                options={cashOptions}
                placeholder="选择账户"
                behavior={{
                  hierarchy: false,
                  search: "auto",
                  clearable: false,
                  create: {
                    type: "button",
                    onClick: () => setNestedEntityType("cash-account"),
                    label: "+",
                  },
                }}
              />
            </div>

            {/* 保额 + 缴费期限 */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <div className="form-label">保额</div>
                <CalcInput
                  value={draft.coverageAmount}
                  onChange={(val) => setDraft({ ...draft, coverageAmount: val })}
                  placeholder="0.00"
                  label="保额"
                  precision={2}
                />
              </div>
              <div className="space-y-1">
                <div className="form-label">缴费期限（年）</div>
                <input
                  type="number"
                  min={1}
                  max={30}
                  inputMode="numeric"
                  value={draft.paymentTermYears}
                  onChange={(e) => setDraft({ ...draft, paymentTermYears: e.target.value })}
                  placeholder="1-30"
                  className="form-input"
                />
              </div>
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

      {nestedEntityType === "cash-account" && (
        <NestedAddModal
          mode="compact"
          entityType="account"
          open={true}
          onClose={() => setNestedEntityType(null)}
          onCreated={(id, name) => {
            const option = { id, label: name, subLabel: kindLabel("bank_debit") };
            setCashAccountList((prev) => [...prev, option]);
            setLocalCashSSOpts((prev) => (prev ? [...prev, option] : prev));
            setDraft((prev) => (prev ? { ...prev, cashAccountId: id } : prev));
            setNestedEntityType(null);
          }}
          extraFields={{ kind: "bank_debit" }}
          hiddenFields={["kind"]}
          nestedFieldData={nestedFieldData}
        />
      )}
    </div>
  );
}
