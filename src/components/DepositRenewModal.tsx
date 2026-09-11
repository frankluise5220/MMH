"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { parseNumber } from "@/lib/investment-config";
import { DateStepper } from "./DateStepper";
import { CalcInput } from "./CalcInput";
import { ModalLayerProvider, getNextModalLayerZIndex, useModalLayerZIndex } from "./ModalLayer";
import { SmartSelect, type SmartSelectOption } from "./SmartSelect";
import { addDepositTermUtc } from "@/lib/date-utils";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { useI18n } from "@/lib/i18n";

export type RenewLotInfo = {
  id: string;
  fundName: string;
  principal: number;
  annualRate: number | null;
  startDate: string | null;
  maturityDate: string | null;
  maturityAction: string | null;
  interestPayoutFrequency?: string | null;
  depositAccountLabel: string;
};

export function DepositRenewModal({
  open,
  onClose,
  lot,
  cashAccounts,
  renewAction,
}: {
  open: boolean;
  onClose: () => void;
  lot: RenewLotInfo | null;
  cashAccounts: Array<{ id: string; label: string }>;
  renewAction: (formData: FormData) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const { t } = useI18n();
  const parentModalZIndex = useModalLayerZIndex();
  const modalZIndex = getNextModalLayerZIndex(parentModalZIndex);

  // Deposits that pay interest periodically have no interest left to roll in,
  // so the roll-in mode is disabled and payout is the only valid mode.
  const rollInDisabled = !!lot && !!lot.interestPayoutFrequency && lot.interestPayoutFrequency !== "maturity";

  const initialMode: "renew_principal_interest" | "renew_principal" =
    lot && (lot.maturityAction === "renew_principal" || rollInDisabled) ? "renew_principal" : "renew_principal_interest";

  const [renewMode, setRenewMode] = useState<"renew_principal_interest" | "renew_principal">(initialMode);
  const [interest, setInterest] = useState("");
  const [newRate, setNewRate] = useState("");
  const [newMaturity, setNewMaturity] = useState("");
  const [cashAccountId, setCashAccountId] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Recompute defaults whenever the target lot changes.
  useEffect(() => {
    if (!open || !lot) return;
    const rollInDisabled = !!lot.interestPayoutFrequency && lot.interestPayoutFrequency !== "maturity";
    setRenewMode(
      lot.maturityAction === "renew_principal" || rollInDisabled
        ? "renew_principal"
        : "renew_principal_interest",
    );
    const rate = lot.annualRate != null && lot.annualRate > 0 ? lot.annualRate : null;
    setNewRate(rate != null ? String(rate) : "");
    const maturity = lot.maturityDate;
    const start = lot.startDate;
    if (maturity) {
      const principal = lot.principal > 0 ? lot.principal : 0;
      const effectiveRate = rate ?? 0;
      const segmentDays = start
        ? Math.max(0, Math.round(
            (new Date(`${maturity}T00:00:00.000Z`).getTime() - new Date(`${start}T00:00:00.000Z`).getTime()) / 86400000,
          ))
        : 0;
      const accrued = principal > 0 && effectiveRate > 0 && segmentDays > 0
        ? Number(((principal * (effectiveRate / 100) * segmentDays) / 365).toFixed(2))
        : 0;
      setInterest(accrued > 0 ? accrued.toFixed(2) : "");
      const termDays = start
        ? Math.max(1, Math.round(
            (new Date(`${maturity}T00:00:00.000Z`).getTime() - new Date(`${start}T00:00:00.000Z`).getTime()) / 86400000,
          ))
        : 365;
      setNewMaturity(addDepositTermUtc(new Date(`${maturity}T00:00:00.000Z`), termDays).toISOString().slice(0, 10));
    } else {
      setInterest("");
      setNewMaturity("");
    }
  }, [open, lot]);

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

  async function submitRenewal() {
    if (!lot || submitting) return;
    const interestValue = parseNumber(interest);
    if (interestValue < 0 || (interest.trim() === "" && !interest)) {
      window.alert(t("deposit.renew.invalidInterest"));
      return;
    }
    const rateValue = parseNumber(newRate);
    if (rateValue <= 0) {
      window.alert(t("deposit.renew.missingRate"));
      return;
    }
    if (!newMaturity) {
      window.alert(t("deposit.renew.missingMaturity"));
      return;
    }
    if (lot.maturityDate && newMaturity <= lot.maturityDate) {
      window.alert(t("deposit.renew.maturityMustMove"));
      return;
    }
    if (renewMode === "renew_principal" && !cashAccountId) {
      window.alert(t("deposit.renew.selectCashAccount"));
      return;
    }
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.set("entryId", lot.id);
      fd.set("renewMode", renewMode);
      fd.set("interest", String(interestValue));
      fd.set("newAnnualRate", String(rateValue));
      fd.set("newMaturityDate", newMaturity);
      if (renewMode === "renew_principal") fd.set("cashAccountId", cashAccountId);
      const res = await renewAction(fd);
      if (!res.ok) throw new Error(res.error);
      dispatchFinanceDataChanged({ reason: "deposit-renew" });
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
          <div className="app-modal-panel max-w-[min(28rem,calc(100vw-1rem))]">
            <div className="modal-header">
              <div className="text-sm font-semibold text-slate-800">
                {t("deposit.renew.title")}
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
                  <span>{t("depositShell.colMaturityDate")}</span>
                  <span className="tabular-nums">{lot.maturityDate || "-"}</span>
                </div>
                <div className="flex justify-between">
                  <span>{t("depositShell.colAnnualRate")}</span>
                  <span className="tabular-nums">{lot.annualRate != null ? `${lot.annualRate}%` : "-"}</span>
                </div>
              </div>

              <div className="space-y-1">
                <div className="form-label">{t("deposit.renew.interestMode")}</div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={rollInDisabled}
                    title={rollInDisabled ? t("deposit.renew.rollInDisabledHint") : undefined}
                    onClick={() => setRenewMode("renew_principal_interest")}
                    className={`segment-button h-8 flex-1 text-xs ${renewMode === "renew_principal_interest" ? "segment-button-active font-medium" : ""} ${rollInDisabled ? "cursor-not-allowed opacity-50" : ""}`}
                  >
                    {t("deposit.renew.modeRollIn")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setRenewMode("renew_principal")}
                    className={`segment-button h-8 flex-1 text-xs ${renewMode === "renew_principal" ? "segment-button-active font-medium" : ""}`}
                  >
                    {t("deposit.renew.modePayout")}
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <div className="form-label">{t("deposit.renew.accruedInterest")}</div>
                  <CalcInput
                    value={interest}
                    onChange={setInterest}
                    placeholder="0.00"
                    label={t("deposit.renew.accruedInterest")}
                    precision={2}
                  />
                </div>
                <div className="space-y-1">
                  <div className="form-label">{t("deposit.renew.newRate")}</div>
                  <CalcInput
                    value={newRate}
                    onChange={setNewRate}
                    placeholder={t("depositForm.rateExample")}
                    label={t("depositShell.colAnnualRate")}
                    precision={4}
                  />
                </div>
                <div className="col-span-2 space-y-1">
                  <div className="form-label">{t("deposit.renew.newMaturity")}</div>
                  <DateStepper value={newMaturity} onChange={setNewMaturity} />
                </div>
                {renewMode === "renew_principal" ? (
                  <div className="col-span-2 space-y-1">
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
                ) : null}
              </div>

              <div className="text-[11px] text-slate-400">{t("deposit.renew.hint")}</div>

              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={onClose} className="secondary-button h-9 px-4 text-sm">
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => { void submitRenewal(); }}
                  className="primary-button h-9 px-4 text-sm disabled:opacity-50"
                >
                  {submitting ? t("txForm.saving") : t("deposit.renew.submit")}
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
