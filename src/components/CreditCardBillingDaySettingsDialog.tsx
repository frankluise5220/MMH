"use client";

import { useEffect, useState } from "react";
import { CREDIT_CARD_MAX_REPAYMENT_OFFSET_DAYS } from "@/lib/credit/rules";
import { CreditCardBillingDayRulesTable } from "@/components/CreditCardBillingDayRulesTable";
import { normalizeBillingDayTxPeriod, type BillingDayTxPeriod } from "@/lib/credit/billing";
import {
  billingDayDisplayValue,
  currentBillingDayFromRules,
  type CreditBillingDayRuleView,
} from "@/lib/credit/billing-day-rules";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { notifySettingsDataChanged } from "@/lib/client/settingsCache";
import { useI18n } from "@/lib/i18n";

type CreditCardBillingDaySettingsDialogProps = {
  open: boolean;
  onClose: () => void;
  accountId: string;
  /** 基础账单日（规则表为空时的兜底）。 */
  billingDay: number | null;
  billingDayTxPeriod?: BillingDayTxPeriod | null;
  repaymentDay?: number | null;
  repaymentOffsetDays?: number | null;
  /** 账单日规则（按生效日期的历史序列），由宿主持有；改动经 onRulesChanged 回传。 */
  rules: CreditBillingDayRuleView[];
  onRulesChanged: (rules: CreditBillingDayRuleView[]) => void;
  /** 账户级设置（归属期 / 还款日）保存成功后的回传，宿主可据此刷新本地展示。 */
  onAccountSettingsSaved?: (data: { repaymentDay?: number | null; repaymentOffsetDays?: number | null }) => void;
};

/**
 * 账单日设置（信用卡账单页与系统设置→账户共用）：
 * 账户级 = 交易归属期 + 还款日（固定日 / 账单日后 N 天）；
 * 规则级 = 按生效日期的账单日历史，改动即存（/api/v1/bill/billing-day-rules）。
 */
export function CreditCardBillingDaySettingsDialog({
  open,
  onClose,
  accountId,
  billingDay,
  billingDayTxPeriod,
  repaymentDay,
  repaymentOffsetDays,
  rules,
  onRulesChanged,
  onAccountSettingsSaved,
}: CreditCardBillingDaySettingsDialogProps) {
  const { t } = useI18n();

  const [txPeriodDraft, setTxPeriodDraft] = useState<BillingDayTxPeriod>(normalizeBillingDayTxPeriod(billingDayTxPeriod));
  const [repaymentDayModeDraft, setRepaymentDayModeDraft] = useState<"fixed" | "offset">(repaymentOffsetDays == null ? "fixed" : "offset");
  const [repaymentDayDraft, setRepaymentDayDraft] = useState(repaymentDay == null ? "" : String(repaymentDay));
  const [repaymentOffsetDaysDraft, setRepaymentOffsetDaysDraft] = useState(repaymentOffsetDays == null ? "" : String(repaymentOffsetDays));
  const [accountSettingsSaving, setAccountSettingsSaving] = useState(false);
  const [accountSettingsError, setAccountSettingsError] = useState("");

  const effectiveBillingDay = currentBillingDayFromRules(rules, billingDay);
  const effectiveBillingDayDisplay = effectiveBillingDay ? billingDayDisplayValue(effectiveBillingDay, t) : "";

  useEffect(() => {
    if (!open) return;
    setTxPeriodDraft(normalizeBillingDayTxPeriod(billingDayTxPeriod));
    setRepaymentDayModeDraft(repaymentOffsetDays == null ? "fixed" : "offset");
    setRepaymentDayDraft(repaymentDay == null ? "" : String(repaymentDay));
    setRepaymentOffsetDaysDraft(repaymentOffsetDays == null ? "" : String(repaymentOffsetDays));
    setAccountSettingsError("");
  }, [open, billingDayTxPeriod, repaymentDay, repaymentOffsetDays]);

  const accountSettingsDirty =
    txPeriodDraft !== normalizeBillingDayTxPeriod(billingDayTxPeriod) ||
    repaymentDayModeDraft !== (repaymentOffsetDays == null ? "fixed" : "offset") ||
    repaymentDayDraft.trim() !== (repaymentDay == null ? "" : String(repaymentDay)) ||
    repaymentOffsetDaysDraft.trim() !== (repaymentOffsetDays == null ? "" : String(repaymentOffsetDays));

  async function saveBillingDayAccountSettings() {
    if (!accountId || accountSettingsSaving) return;
    const dayText = repaymentDayDraft.trim();
    const offsetDaysText = repaymentOffsetDaysDraft.trim();
    if (repaymentDayModeDraft === "fixed" && dayText !== "") {
      const day = Number(dayText);
      if (!Number.isInteger(day) || day < 1 || day > 31) {
        setAccountSettingsError(t("creditBill.billingDayInvalidRepaymentDay"));
        return;
      }
    }
    if (repaymentDayModeDraft === "offset") {
      const days = Number(offsetDaysText);
      if (!Number.isInteger(days) || days < 0 || days > CREDIT_CARD_MAX_REPAYMENT_OFFSET_DAYS) {
        setAccountSettingsError(t("creditBill.billingDayInvalidRepaymentOffsetDays"));
        return;
      }
    }
    setAccountSettingsSaving(true);
    setAccountSettingsError("");
    try {
      const fixedMode = repaymentDayModeDraft === "fixed";
      const response = await fetch("/api/v1/bill/billing-day-rules", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          billingDayTxPeriod: txPeriodDraft,
          repaymentDayMode: repaymentDayModeDraft,
          repaymentDay: fixedMode && dayText !== "" ? Number(dayText) : null,
          repaymentOffsetDays: !fixedMode ? Number(offsetDaysText) : null,
        }),
      });
      const data = await response.json().catch(() => null) as {
        ok?: boolean;
        error?: string;
        data?: { accountIds?: string[]; repaymentDay?: number | null; repaymentOffsetDays?: number | null };
      } | null;
      if (!response.ok || !data?.ok) {
        setAccountSettingsError(data?.error || t("creditBill.billingDayAccountSaveFailed"));
        return;
      }
      setRepaymentDayDraft(data.data?.repaymentDay == null ? "" : String(data.data.repaymentDay));
      setRepaymentOffsetDaysDraft(data.data?.repaymentOffsetDays == null ? "" : String(data.data.repaymentOffsetDays));
      setRepaymentDayModeDraft(data.data?.repaymentOffsetDays == null ? "fixed" : "offset");
      onAccountSettingsSaved?.(data.data ?? {});
      void notifySettingsDataChanged({ scope: "accounts", reason: "billing-day-settings", prefetch: true });
      dispatchFinanceDataChanged({
        reason: "account-credit-cycle-settings",
        accountIds: Array.isArray(data.data?.accountIds) && data.data.accountIds.length > 0 ? data.data.accountIds : [accountId],
        balanceChanged: true,
      });
    } catch {
      setAccountSettingsError(t("creditBill.billingDayAccountSaveFailed"));
    } finally {
      setAccountSettingsSaving(false);
    }

  }

  return (
    <>
      {open ? (
        <div className="app-modal-backdrop">
          <div className="app-modal-panel max-w-lg">
            <div className="modal-header shrink-0 gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-slate-800">{t("creditBill.billingDaySettingsTitle")}</div>
                <div className="mt-0.5 text-xs text-slate-500">{t("creditBill.billingDaySettingsDesc", { day: effectiveBillingDayDisplay })}</div>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="secondary-button h-8 min-w-14 shrink-0 whitespace-nowrap px-3"
              >
                {t("table.close")}
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
              <div className="rounded-lg border border-slate-200 bg-white p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-500">{t("creditBill.billingDayAccountSection")}</span>
                  <button
                    type="button"
                    onClick={() => void saveBillingDayAccountSettings()}
                    disabled={!accountSettingsDirty || accountSettingsSaving}
                    className="primary-button h-7 px-3 text-xs"
                  >
                    {accountSettingsSaving ? t("creditBill.saving") : t("common.save")}
                  </button>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <label className="block">
                    <span className="mb-1 block text-xs text-slate-500">{t("settings.accounts.billingDayTxPeriodLabel")}</span>
                    <select
                      value={txPeriodDraft}
                      onChange={(event) => setTxPeriodDraft(normalizeBillingDayTxPeriod(event.target.value))}
                      className="form-input w-full text-xs"
                    >
                      <option value="current">{t("creditBill.billingDayTxPeriod.current")}</option>
                      <option value="next">{t("creditBill.billingDayTxPeriod.next")}</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs text-slate-500">{t("settings.accounts.repaymentDayModeLabel")}</span>
                    <select
                      value={repaymentDayModeDraft}
                      onChange={(event) => setRepaymentDayModeDraft(event.target.value === "offset" ? "offset" : "fixed")}
                      className="form-input w-full text-xs"
                    >
                      <option value="fixed">{t("entityForm.repaymentDayMode.fixed")}</option>
                      <option value="offset">{t("entityForm.repaymentDayMode.offset")}</option>
                    </select>
                  </label>
                  {repaymentDayModeDraft === "fixed" ? (
                    <label className="block">
                      <span className="mb-1 block text-xs text-slate-500">{t("settings.accounts.repaymentDayLabel")}</span>
                      <input
                        value={repaymentDayDraft}
                        onChange={(event) => setRepaymentDayDraft(event.target.value)}
                        inputMode="numeric"
                        placeholder={t("creditBill.repaymentDayPlaceholder")}
                        className="form-input w-full text-xs"
                      />
                    </label>
                  ) : (
                    <label className="block">
                      <span className="mb-1 block text-xs text-slate-500">{t("settings.accounts.repaymentOffsetDaysLabel")}</span>
                      <input
                        value={repaymentOffsetDaysDraft}
                        onChange={(event) => setRepaymentOffsetDaysDraft(event.target.value)}
                        inputMode="numeric"
                        placeholder={t("creditBill.repaymentOffsetDaysPlaceholder")}
                        className="form-input w-full text-xs"
                      />
                    </label>
                  )}
                </div>
                {accountSettingsError ? <div className="mt-2 text-xs text-red-600">{accountSettingsError}</div> : null}
              </div>
              <CreditCardBillingDayRulesTable
                accountId={accountId}
                rules={rules}
                onRulesChanged={onRulesChanged}
                billingDay={billingDay}
              />
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
