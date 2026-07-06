"use client";

import { useEffect, useState } from "react";

import {
  InsuranceEntryEditModal,
  type InsuranceEntryEditValue,
} from "./InsuranceEntryEditModal";
import type { SmartSelectOption } from "./SmartSelect";
import { getInsuranceAction, getInsuranceProductName } from "@/lib/insurance/transaction";

type AccountOption = {
  id: string;
  label: string;
  icon?: string;
  subLabel?: string;
};

type NestedFieldData = Record<string, Array<{ id: string; name: string; type?: string }>>;

type InsuranceEditEventDetail = {
  requestId?: string;
  entryId: string;
  date?: string;
  amount?: number;
  note?: string;
  cashAccountId?: string;
  accountId?: string | null;
  toAccountId?: string | null;
  insuranceAction?: "premium" | "refund";
  insuranceProductName?: string | null;
  insuranceProductId?: string | null;
};

function toDateString(value: unknown) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 10) : new Date().toISOString().slice(0, 10);
}

function toAmountString(value: unknown) {
  const amount = Math.abs(Number(value ?? 0));
  return Number.isFinite(amount) && amount > 0 ? String(amount) : "";
}

export function InsuranceEntryEditBridge({
  cashAccounts,
  cashAccountSSOptions,
  nestedFieldData,
}: {
  cashAccounts?: AccountOption[];
  cashAccountSSOptions?: SmartSelectOption[];
  nestedFieldData?: NestedFieldData;
}) {
  const [value, setValue] = useState<InsuranceEntryEditValue | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let activeRequest = "";

    async function onInsuranceEdit(event: Event) {
      const detail = (event as CustomEvent<InsuranceEditEventDetail>).detail;
      if (!detail?.entryId) return;
      const requestId = detail.requestId ?? `${detail.entryId}-${Date.now()}`;
      activeRequest = requestId;
      setLoading(true);

      try {
        const response = await fetch(
          `/api/v1/transactions/detail?id=${encodeURIComponent(detail.entryId)}`,
          { cache: "no-store" },
        );
        const data = (await response.json().catch(() => null)) as
          | { ok?: boolean; data?: Record<string, any>; error?: string }
          | null;
        if (!response.ok || !data?.ok || !data.data) {
          throw new Error(data?.error || "读取保险续期记录失败");
        }
        if (activeRequest !== requestId) return;

        const entry = data.data;
        const sourceIsInsurance = entry.source === "insurance" || !!entry.insuranceProductId;
        if (!sourceIsInsurance) {
          throw new Error("这条记录不是保险续期记录");
        }

        const insuranceAction = getInsuranceAction(entry);
        const isRedeem = insuranceAction === "refund";
        const cashAccountId =
          detail.cashAccountId ||
          (isRedeem ? entry.toAccountId : entry.accountId) ||
          "";

        setValue({
          id: String(entry.id),
          date: toDateString(entry.date ?? detail.date),
          amount: toAmountString(entry.amount ?? detail.amount),
          cashAccountId,
          coverageAmount: entry.coverageAmount == null ? "" : String(entry.coverageAmount),
          paymentTermYears: entry.paymentTermYears == null ? "" : String(entry.paymentTermYears),
          note: String(entry.note ?? detail.note ?? ""),
          insuranceAction,
          insuranceProductId: String(entry.insuranceProductId ?? detail.insuranceProductId ?? ""),
          insuranceProductName: getInsuranceProductName({
            source: "insurance",
            insuranceProductName: entry.insuranceProductName ?? detail.insuranceProductName ?? null,
            fundName: entry.fundName ?? null,
          }) || "保险续期",
        });
      } catch (error) {
        window.alert(error instanceof Error ? error.message : "读取保险续期记录失败");
      } finally {
        if (activeRequest === requestId) setLoading(false);
      }
    }

    window.addEventListener("mmh:insurance:edit", onInsuranceEdit as EventListener);
    return () => {
      activeRequest = "";
      window.removeEventListener("mmh:insurance:edit", onInsuranceEdit as EventListener);
    };
  }, []);

  return (
    <>
      <InsuranceEntryEditModal
        open={!!value}
        value={value}
        cashAccounts={cashAccounts}
        cashAccountSSOptions={cashAccountSSOptions}
        nestedFieldData={nestedFieldData}
        onClose={() => {
          if (!loading) setValue(null);
        }}
        onSaved={async (next) => {
          setValue(next);
          window.dispatchEvent(new Event("mmh:fund:refresh"));
        }}
      />
    </>
  );
}
