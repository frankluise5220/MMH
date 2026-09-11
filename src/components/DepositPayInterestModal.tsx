"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { parseNumber } from "@/lib/investment-config";
import { DateStepper } from "./DateStepper";
import { CalcInput } from "./CalcInput";
import { ModalLayerProvider, getNextModalLayerZIndex, useModalLayerZIndex } from "./ModalLayer";
import { SmartSelect, type SmartSelectOption } from "./SmartSelect";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { useI18n } from "@/lib/i18n";

export type PayInterestLotInfo = {
  id: string;
  fundName: string;
  principal: number;
  annualRate: number | null;
  maturityDate: string | null;
  interestPayoutFrequency: string | null;
};

export function DepositPayInterestModal({
  open,
  onClose,
  lot,
  cashAccounts,
  payInterestAction,
}: {
  open: boolean;
  onClose: () => void;
  lot: PayInterestLotInfo | null;
  cashAccounts: Array<{ id: string; label: string }>;
  payInterestAction: (formData: FormData) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const { t } = useI18n();
  const parentModalZIndex = useModalLayerZIndex();
  const modalZIndex = getNextModalLayerZIndex(parentModalZIndex);
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const [payoutDate, setPayoutDate] = useState(today);
  const [amount, setAmount] = useState("");
  const [cashAccountId, setCashAccountId] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open || !lot) return;
    setPayoutDate(today);
    // Preview only: the server recomputes from the actual interest segment
    // (last payout / renewal date) and lets the user override it here.
    setAmount("");
  }, [open, lot, today]);

  const cashAccountOptions: SmartSelectOption[] = useMemo(
    () => cashAccounts.map((account) => ({ id: account.id, label: account.label })),
    [cashAccounts],
  );

  useEffect(() => {
    if (open && !cashAccountId && cashAccounts.length > 0) {
      setCashAccountId(cashAccounts[0].id);
    }
  }, [open, cashAccounts, cashAccountId]);

  if (!open || !lot) return null;

  const principalText = lot.principal > 0 ? lot.principal.toFixed(2) : "0.00";

  async function submitPayout() {
    if (!lot || submitting) return;
    const amountValue = parseNumber(amount);
    if (!cashAccountId) {
      window.alert(t("deposit.payInterest.selectCashAccount"));
      return;
    }
    if (!(amountValue > 0)) {
      window.alert(t("deposit.payInterest.noAccrual"));
      return;
    }
    if (lot.maturityDate && payoutDate > lot.maturityDate) {
      window.alert(t("deposit.payInterest.afterMaturity"));
      return;
    }
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.set("entryId", lot.id);
      fd.set("amount", String(amountValue));
      fd.set("date", payoutDate);
      fd.set("cashAccountId", cashAccountId);
      const res = await payInterestAction(fd);
      if (!res.ok) throw new Error(res.error);
      dispatchFinanceDataChanged({ reason: "deposit-pay-interest" });
      onClose();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : t("txForm.alert.saveFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ModalLayerProvider value={modalZIndex}>
      {createPortal(
        <div className="app-modal-backdrop" style={{ zIndex: modalZIndex }}>
          <div className="app-modal-panel max-w-[min(26rem,calc(100vw-1rem))]">
            <div className="modal-header">
              <div className="text-sm font-semibold text-slate-800">
                {t("deposit.payInterest.title")}
                <span className="ml-2 text-xs font-normal text-slate-500">{lot.fundName}</span>
              </div>
              <button type="button" onClick={onClose} className="secondary-button h-8 px-2">
                {t("investForm.close")}
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3 sm:p-4">
              <div className="rounded-[10px] bg-slate-50 px-3 py-2 text-xs text-slate-600">
                <div className="flex justify-between">
                  <span>{t("depositShell.colOriginalAmount")}</span>
                  <span className="font-medium tabular-nums">{principalText}</span>
                </div>
                <div className="flex justify-between">
                  <span>{t("depositShell.colAnnualRate")}</span>
                  <span className="tabular-nums">{lot.annualRate != null ? `${lot.annualRate}%` : "-"}</span>
                </div>
              </div>

              <div className="space-y-1">
                <div className="form-label">{t("detail.column.date")}</div>
                <DateStepper value={payoutDate} onChange={setPayoutDate} />
              </div>

              <div className="space-y-1">
                <div className="form-label">{t("txForm.interest")}</div>
                <CalcInput
                  value={amount}
                  onChange={setAmount}
                  placeholder={t("deposit.payInterest.amountPlaceholder")}
                  label={t("txForm.interest")}
                  precision={2}
                />
                <div className="text-[11px] text-slate-400">{t("deposit.payInterest.hint")}</div>
              </div>

              <div className="space-y-1">
                <div className="form-label">{t("deposit.renew.cashAccount")}</div>
                <SmartSelect
                  mode="single"
                  value={cashAccountId}
                  onChange={setCashAccountId}
                  options={cashAccountOptions}
                  placeholder={t("fundShell.selectAccount")}
                  behavior={{ hierarchy: false, search: "auto", clearable: false }}
                />
              </div>

              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={onClose} className="secondary-button h-9 px-4 text-sm">
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => { void submitPayout(); }}
                  className="primary-button h-9 px-4 text-sm disabled:opacity-50"
                >
                  {submitting ? t("txForm.saving") : t("deposit.payInterest.submit")}
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </ModalLayerProvider>
  );
}
