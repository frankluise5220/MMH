"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { DateStepper } from "@/components/DateStepper";
import {
  billingDayDisplayValue,
  billingDayRuleKey,
  currentBillingDayFromRules,
  type CreditBillingDayRuleView,
} from "@/lib/credit/billing-day-rules";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { useI18n } from "@/lib/i18n";

type CreditCardBillingDayRulesTableProps = {
  accountId: string;
  /** 账单日规则（按生效日期的历史序列），由宿主持有；改动经 onRulesChanged 回传。 */
  rules: CreditBillingDayRuleView[];
  onRulesChanged: (rules: CreditBillingDayRuleView[]) => void;
  /** 基础账单日：规则表为空时作为「当前生效值」的兜底，也是新增规则的默认值。 */
  billingDay?: number | null;
};

/**
 * 账单日历史表（可内嵌）：按生效日期记录账单日变化，增删改即存
 * （/api/v1/bill/billing-day-rules）。
 * 信用卡账单页的「账单日设置」弹窗与 设置→账户 的信用卡编辑表单共用这一个实现。
 */
export function CreditCardBillingDayRulesTable({
  accountId,
  rules,
  onRulesChanged,
  billingDay,
}: CreditCardBillingDayRulesTableProps) {
  const router = useRouter();
  const { t } = useI18n();
  const effectiveBillingDay = currentBillingDayFromRules(rules, billingDay ?? null);

  const [billingDayRuleEditing, setBillingDayRuleEditing] = useState<string | null>(null);
  const [billingDayRuleForm, setBillingDayRuleForm] = useState({ effectiveDate: "", billingDay: "" });
  const [billingDayRuleSaving, setBillingDayRuleSaving] = useState(false);
  const [billingDayRuleError, setBillingDayRuleError] = useState("");

  const resetBillingDayRuleEditor = () => {
    setBillingDayRuleEditing(null);
    setBillingDayRuleForm({ effectiveDate: "", billingDay: "" });
    setBillingDayRuleError("");
  };

  const applyBillingDayRulesResponse = (data: { rules?: CreditBillingDayRuleView[] } | null | undefined) => {
    if (Array.isArray(data?.rules)) {
      onRulesChanged(data.rules);
      dispatchFinanceDataChanged({ reason: "billing-day-rule", accountIds: [accountId], balanceChanged: true });
      router.refresh();
      return true;
    }
    return false;
  };

  async function saveBillingDayRule(mode: "create" | "edit") {
    if (!accountId || billingDayRuleSaving) return;
    const dayValue = Number(billingDayRuleForm.billingDay);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(billingDayRuleForm.effectiveDate.trim())) {
      setBillingDayRuleError(t("creditBill.billingDayRuleInvalidDate"));
      return;
    }
    if (!Number.isInteger(dayValue) || dayValue < 1 || dayValue > 31) {
      setBillingDayRuleError(t("creditBill.billingDayRuleInvalidDay"));
      return;
    }
    setBillingDayRuleSaving(true);
    setBillingDayRuleError("");
    try {
      const originalRule = mode === "edit" && billingDayRuleEditing
        ? rules.find((rule) => billingDayRuleKey(rule) === billingDayRuleEditing)
        : undefined;
      const original = originalRule?.effectiveDate;
      const response = await fetch("/api/v1/bill/billing-day-rules", {
        method: original ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          billingDay: dayValue,
          effectiveDate: billingDayRuleForm.effectiveDate.trim(),
          ...(original ? { originalEffectiveDate: original } : {}),
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) {
        setBillingDayRuleError(data?.error || t("creditBill.billingDayRuleSaveFailed"));
        return;
      }
      if (applyBillingDayRulesResponse(data.data)) resetBillingDayRuleEditor();
    } catch {
      setBillingDayRuleError(t("creditBill.billingDayRuleSaveFailed"));
    } finally {
      setBillingDayRuleSaving(false);
    }
  }

  async function deleteBillingDayRule(rule: CreditBillingDayRuleView) {
    if (!accountId || billingDayRuleSaving) return;
    if (!window.confirm(t("creditBill.billingDayRuleDeleteConfirm", { date: rule.effectiveDate, day: billingDayDisplayValue(rule.billingDay, t) }))) return;
    setBillingDayRuleSaving(true);
    setBillingDayRuleError("");
    try {
      const response = await fetch("/api/v1/bill/billing-day-rules", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, ruleId: rule.id, effectiveDate: rule.effectiveDate }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) {
        setBillingDayRuleError(data?.error || t("creditBill.billingDayRuleDeleteFailed"));
        return;
      }
      applyBillingDayRulesResponse(data.data);
      if (billingDayRuleEditing === billingDayRuleKey(rule)) resetBillingDayRuleEditor();
    } catch {
      setBillingDayRuleError(t("creditBill.billingDayRuleDeleteFailed"));
    } finally {
      setBillingDayRuleSaving(false);
    }

  }

  return (
    <>
              <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
                  <span className="text-xs font-medium text-slate-500">{t("creditBill.billingDayRuleSectionTitle")}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setBillingDayRuleEditing("new");
                      setBillingDayRuleForm({
                        effectiveDate: new Date().toISOString().slice(0, 10),
                        billingDay: effectiveBillingDay ? String(effectiveBillingDay) : "",
                      });
                      setBillingDayRuleError("");
                    }}
                    disabled={billingDayRuleSaving || billingDayRuleEditing !== null}
                    className="secondary-button inline-flex h-7 items-center gap-1 px-2 text-xs disabled:opacity-50"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {t("creditBill.billingDayRuleAdd")}
                  </button>
                </div>
                <div className="max-h-[260px] overflow-y-auto">
                  <table className="min-w-full table-fixed text-sm">
                    <thead className="sticky top-0 bg-slate-50 text-xs font-medium text-slate-500 shadow-[0_1px_0_0_#e2e8f0]">
                      <tr>
                        <th className="w-[44%] px-3 py-2 text-left">{t("creditBill.billingDayRuleDate")}</th>
                        <th className="w-[26%] px-3 py-2 text-right">{t("creditBill.billingDayRuleDay")}</th>
                        <th className="w-[30%] px-3 py-2 text-right">{t("creditBill.billingDayRuleActions")}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {rules.length === 0 && billingDayRuleEditing !== "new" ? (
                        <tr>
                          <td colSpan={3} className="px-3 py-8 text-center text-sm text-slate-500">{t("creditBill.billingDayRuleEmpty")}</td>
                        </tr>
                      ) : null}
                      {rules.map((rule) => (
                        billingDayRuleEditing === billingDayRuleKey(rule) ? (
                          <tr key={billingDayRuleKey(rule)} className="bg-amber-50/50">
                            <td className="px-3 py-2 align-middle">
                              <DateStepper
                                value={billingDayRuleForm.effectiveDate}
                                onChange={(value) => setBillingDayRuleForm((current) => ({ ...current, effectiveDate: value }))}
                              />
                            </td>
                            <td className="px-3 py-2 text-right align-middle">
                              <input
                                value={billingDayRuleForm.billingDay}
                                onChange={(event) => setBillingDayRuleForm((current) => ({ ...current, billingDay: event.target.value }))}
                                inputMode="numeric"
                                placeholder={t("entityForm.billingDayPlaceholder")}
                                className="form-input text-right"
                              />
                            </td>
                            <td className="px-3 py-2 text-right align-middle">
                              <div className="inline-flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => void saveBillingDayRule("edit")}
                                  disabled={billingDayRuleSaving}
                                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-slate-200 bg-white text-emerald-600 transition-colors hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"
                                  title={t("common.save")}
                                  aria-label={t("common.save")}
                                >
                                  <Check className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={resetBillingDayRuleEditor}
                                  disabled={billingDayRuleSaving}
                                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-slate-200 bg-white text-slate-500 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                                  title={t("common.cancel")}
                                  aria-label={t("common.cancel")}
                                >
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ) : (
                          <tr key={billingDayRuleKey(rule)} className={rule.isInitial ? "bg-blue-50/50" : "bg-white"}>
                            <td className="px-3 py-2 align-middle">
                              <span className="tabular-nums text-slate-700">{rule.effectiveDate}</span>
                              {rule.isInitial ? <span className="ml-1.5 rounded bg-slate-100 px-1 py-0.5 text-[10px] text-slate-500">{t("creditBill.billingDayRuleInitial")}</span> : null}
                            </td>
                            <td className="px-3 py-2 text-right align-middle tabular-nums text-slate-700">{billingDayDisplayValue(rule.billingDay, t)}</td>
                            <td className="px-3 py-2 text-right align-middle">
                              <div className="inline-flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setBillingDayRuleEditing(billingDayRuleKey(rule));
                                    setBillingDayRuleForm({ effectiveDate: rule.effectiveDate, billingDay: String(rule.billingDay) });
                                    setBillingDayRuleError("");
                                  }}
                                  disabled={billingDayRuleSaving}
                                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-slate-200 bg-white text-slate-600 transition-colors hover:bg-slate-50 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
                                  title={t("common.edit")}
                                  aria-label={t("creditBill.billingDayRuleEdit")}
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void deleteBillingDayRule(rule)}
                                  disabled={billingDayRuleSaving || rule.isInitial}
                                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-slate-200 bg-white text-rose-600 transition-colors hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
                                  title={rule.isInitial ? t("creditBill.billingDayRuleDeleteInitialHint") : t("common.delete")}
                                  aria-label={t("creditBill.billingDayRuleDelete")}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        )
                      ))}
                      {billingDayRuleEditing === "new" ? (
                        <tr className="bg-amber-50/50">
                          <td className="px-3 py-2 align-middle">
                            <DateStepper
                              value={billingDayRuleForm.effectiveDate}
                              onChange={(value) => setBillingDayRuleForm((current) => ({ ...current, effectiveDate: value }))}
                            />
                          </td>
                          <td className="px-3 py-2 text-right align-middle">
                            <input
                              value={billingDayRuleForm.billingDay}
                              onChange={(event) => setBillingDayRuleForm((current) => ({ ...current, billingDay: event.target.value }))}
                              inputMode="numeric"
                              placeholder={t("entityForm.billingDayPlaceholder")}
                              className="form-input text-right"
                            />
                          </td>
                          <td className="px-3 py-2 text-right align-middle">
                            <div className="inline-flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => void saveBillingDayRule("create")}
                                disabled={billingDayRuleSaving}
                                className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-slate-200 bg-white text-emerald-600 transition-colors hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"
                                title={t("common.save")}
                                aria-label={t("common.save")}
                              >
                                <Check className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={resetBillingDayRuleEditor}
                                disabled={billingDayRuleSaving}
                                className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-slate-200 bg-white text-slate-500 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                                title={t("common.cancel")}
                                aria-label={t("common.cancel")}
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </div>
              {billingDayRuleError ? <div className="text-xs text-red-600">{billingDayRuleError}</div> : null}
              <div className="text-xs leading-5 text-slate-500">{t("creditBill.billingDayRuleHint")}</div>
    </>
  );
}
