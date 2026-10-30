"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { ROW_ACTION_BUTTON_BOX_CLASS } from "@/components/AdvancedDataTable";
import { DateStepper } from "@/components/DateStepper";
import {
  billingDayDisplayValue,
  billingDayRuleKey,
  currentBillingDayFromRules,
  type CreditBillingDayRuleView,
} from "@/lib/credit/billing-day-rules";
import { CREDIT_CARD_MAX_REPAYMENT_OFFSET_DAYS } from "@/lib/credit/rules";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { useI18n } from "@/lib/i18n";
import { todayDateLocalYmd } from "@/lib/date-utils";

/** 一条记录的还款日口径：固定日 或「账单日后 N 天」。 */
type RepaymentMode = "fixed" | "offset";

type CreditCardBillingDayRulesTableProps = {
  accountId: string;
  /** 账单日/还款日规则（按生效日期的历史序列），由宿主持有；改动经 onRulesChanged 回传。 */
  rules: CreditBillingDayRuleView[];
  onRulesChanged: (rules: CreditBillingDayRuleView[]) => void;
  /** 基础账单日：规则表为空时作为「当前生效值」的兜底，也是新增规则的默认值。 */
  billingDay?: number | null;
  /**
   * 账户级还款日口径与默认值：记录里没写还款日时沿用它们，
   * 新增一条记录时也按这个口径录入（银行改账单日时还款日通常同时改）。
   */
  repaymentDayMode?: RepaymentMode;
  repaymentDay?: number | null;
  repaymentOffsetDays?: number | null;
};

/**
 * 账单日 / 还款日变更历史（可内嵌）：按生效日期记录一次变更，增删改即存
 * （/api/v1/bill/billing-day-rules）。银行改账单日时还款日通常一起改，
 * 所以两者写在同一行，避免两个地方各记一套、对不上。
 * 信用卡账单页的「账单日设置」弹窗与 设置→账户 的信用卡编辑表单共用这一个实现。
 */
export function CreditCardBillingDayRulesTable({
  accountId,
  rules,
  onRulesChanged,
  billingDay,
  repaymentDayMode,
  repaymentDay,
  repaymentOffsetDays,
}: CreditCardBillingDayRulesTableProps) {
  const router = useRouter();
  const { t } = useI18n();
  const effectiveBillingDay = currentBillingDayFromRules(rules, billingDay ?? null);
  const accountRepaymentMode: RepaymentMode = repaymentDayMode
    ?? (repaymentOffsetDays != null ? "offset" : "fixed");

  /** 账户级默认还款日的显示文案（记录里没写时用它说明「沿用」）。 */
  const accountRepaymentText = repaymentOffsetDays != null
    ? t("creditBill.billingDayRuleRepaymentOffsetValue", { days: repaymentOffsetDays })
    : repaymentDay
      ? billingDayDisplayValue(repaymentDay, t)
      : "";

  function ruleRepaymentMode(rule: CreditBillingDayRuleView): RepaymentMode {
    if (rule.repaymentOffsetDays != null) return "offset";
    if (rule.repaymentDay != null) return "fixed";
    return accountRepaymentMode;
  }

  function ruleRepaymentValue(rule: CreditBillingDayRuleView) {
    if (rule.repaymentOffsetDays != null) return rule.repaymentOffsetDays;
    if (rule.repaymentDay != null) return rule.repaymentDay;
    return null;
  }

  const [billingDayRuleEditing, setBillingDayRuleEditing] = useState<string | null>(null);
  const [billingDayRuleForm, setBillingDayRuleForm] = useState({
    effectiveDate: "",
    billingDay: "",
    repayment: "",
    repaymentMode: "fixed" as RepaymentMode,
  });
  const [billingDayRuleSaving, setBillingDayRuleSaving] = useState(false);
  const [billingDayRuleError, setBillingDayRuleError] = useState("");

  const resetBillingDayRuleEditor = () => {
    setBillingDayRuleEditing(null);
    setBillingDayRuleForm({ effectiveDate: "", billingDay: "", repayment: "", repaymentMode: "fixed" });
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
    const repaymentText = billingDayRuleForm.repayment.trim();
    const repaymentNumber = repaymentText === "" ? null : Number(repaymentText);
    if (billingDayRuleForm.repaymentMode === "fixed" && repaymentNumber != null) {
      if (!Number.isInteger(repaymentNumber) || repaymentNumber < 1 || repaymentNumber > 31) {
        setBillingDayRuleError(t("creditBill.billingDayInvalidRepaymentDay"));
        return;
      }
    }
    if (billingDayRuleForm.repaymentMode === "offset" && repaymentNumber != null) {
      if (
        !Number.isInteger(repaymentNumber) ||
        repaymentNumber < 0 ||
        repaymentNumber > CREDIT_CARD_MAX_REPAYMENT_OFFSET_DAYS
      ) {
        setBillingDayRuleError(t("creditBill.billingDayInvalidRepaymentOffsetDays"));
        return;
      }
    }
    setBillingDayRuleSaving(true);
    setBillingDayRuleError("");
    try {
      const originalRule = mode === "edit" && billingDayRuleEditing
        ? rules.find((rule) => billingDayRuleKey(rule) === billingDayRuleEditing)
        : undefined;
      const original = originalRule?.effectiveDate;
      const fixedMode = billingDayRuleForm.repaymentMode === "fixed";
      const response = await fetch("/api/v1/bill/billing-day-rules", {
        method: original ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          billingDay: dayValue,
          effectiveDate: billingDayRuleForm.effectiveDate.trim(),
          // 留空 = 这条记录不覆盖还款日，沿用账户级设置。
          repaymentDay: fixedMode ? repaymentNumber : null,
          repaymentOffsetDays: fixedMode ? null : repaymentNumber,
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
    const repaymentText = rule.repaymentOffsetDays != null
      ? t("creditBill.billingDayRuleRepaymentOffsetValue", { days: rule.repaymentOffsetDays })
      : rule.repaymentDay != null
        ? billingDayDisplayValue(rule.repaymentDay, t)
        : accountRepaymentText;
    if (!window.confirm(t("creditBill.billingDayRuleDeleteConfirm", {
      date: rule.effectiveDate,
      day: billingDayDisplayValue(rule.billingDay, t),
      repayment: repaymentText || "-",
    }))) return;
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

  const startEditingRule = (rule: CreditBillingDayRuleView) => {
    const repaymentMode = ruleRepaymentMode(rule);
    const value = ruleRepaymentValue(rule);
    setBillingDayRuleEditing(billingDayRuleKey(rule));
    setBillingDayRuleForm({
      effectiveDate: rule.effectiveDate,
      billingDay: String(rule.billingDay),
      repayment: value == null ? "" : String(value),
      repaymentMode,
    });
    setBillingDayRuleError("");
  };

  return (
    <>
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-3 py-2">
          {/* 当前生效值就显示在标题后面：账户编辑弹窗里不再单独放「账单日」「还款日」字段。 */}
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="shrink-0 text-xs font-medium text-slate-500">{t("creditBill.billingDayRuleSectionTitle")}</span>
            {effectiveBillingDay ? (
              <span className="truncate text-[11px] tabular-nums text-slate-400">
                {t("creditBill.billingDayRuleCurrent", { day: billingDayDisplayValue(effectiveBillingDay, t) })}
              </span>
            ) : null}
            {accountRepaymentText ? (
              <span className="truncate text-[11px] tabular-nums text-slate-400">
                {t("creditBill.billingDayRuleRepaymentCurrent", { day: accountRepaymentText })}
              </span>
            ) : null}
          </span>
          <button
            type="button"
            onClick={() => {
              setBillingDayRuleEditing("new");
              setBillingDayRuleForm({
                effectiveDate: todayDateLocalYmd(),
                billingDay: effectiveBillingDay ? String(effectiveBillingDay) : "",
                // 新增默认沿用账户口径的值，用户只改实际变动的那一项即可。
                repayment: accountRepaymentMode === "offset"
                  ? (repaymentOffsetDays == null ? "" : String(repaymentOffsetDays))
                  : (repaymentDay == null ? "" : String(repaymentDay)),
                repaymentMode: accountRepaymentMode,
              });
              setBillingDayRuleError("");
            }}
            disabled={billingDayRuleSaving || billingDayRuleEditing !== null}
            className="secondary-button inline-flex h-7 shrink-0 items-center gap-1 px-2 text-xs disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" />
            {t("creditBill.billingDayRuleAdd")}
          </button>
        </div>
        <div className="max-h-[260px] overflow-y-auto">
          <table className="min-w-full table-fixed text-sm">
            <thead className="sticky top-0 bg-slate-50 text-xs font-medium text-slate-500 shadow-[0_1px_0_0_#e2e8f0]">
              <tr>
                <th className="w-[28%] px-3 py-2 text-left">{t("creditBill.billingDayRuleDate")}</th>
                <th className="w-[18%] px-2 py-2 text-right">{t("creditBill.billingDayRuleDay")}</th>
                <th className="w-[24%] px-2 py-2 text-right">{t("creditBill.billingDayRuleRepaymentDay")}</th>
                <th className="w-[30%] px-3 py-2 text-right">{t("creditBill.billingDayRuleActions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rules.length === 0 && billingDayRuleEditing !== "new" ? (
                <tr>
                  <td colSpan={4} className="px-3 py-8 text-center text-sm text-slate-500">{t("creditBill.billingDayRuleEmpty")}</td>
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
                    <td className="px-2 py-2 text-right align-middle">
                      <input
                        value={billingDayRuleForm.billingDay}
                        onChange={(event) => setBillingDayRuleForm((current) => ({ ...current, billingDay: event.target.value }))}
                        inputMode="numeric"
                        placeholder={t("entityForm.billingDayPlaceholder")}
                        className="form-input text-right"
                      />
                    </td>
                    <td className="px-2 py-2 text-right align-middle">
                      <input
                        value={billingDayRuleForm.repayment}
                        onChange={(event) => setBillingDayRuleForm((current) => ({ ...current, repayment: event.target.value }))}
                        inputMode="numeric"
                        placeholder={billingDayRuleForm.repaymentMode === "offset"
                          ? t("creditBill.repaymentOffsetDaysPlaceholder")
                          : t("creditBill.repaymentDayPlaceholder")}
                        title={t("creditBill.billingDayRuleRepaymentHint")}
                        className="form-input text-right"
                      />
                    </td>
                    <td className="px-3 py-2 text-right align-middle">
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => void saveBillingDayRule("edit")}
                          disabled={billingDayRuleSaving}
                          className={`${ROW_ACTION_BUTTON_BOX_CLASS} border-slate-200 bg-white text-emerald-600 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50`}
                          title={t("common.save")}
                          aria-label={t("common.save")}
                        >
                          <Check className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={resetBillingDayRuleEditor}
                          disabled={billingDayRuleSaving}
                          className={`${ROW_ACTION_BUTTON_BOX_CLASS} border-slate-200 bg-white text-slate-500 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50`}
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
                    <td className="px-2 py-2 text-right align-middle tabular-nums text-slate-700">{billingDayDisplayValue(rule.billingDay, t)}</td>
                    <td className="px-2 py-2 text-right align-middle tabular-nums">
                      {rule.repaymentOffsetDays != null ? (
                        <span className="text-slate-700">{t("creditBill.billingDayRuleRepaymentOffsetValue", { days: rule.repaymentOffsetDays })}</span>
                      ) : rule.repaymentDay != null ? (
                        <span className="text-slate-700">{billingDayDisplayValue(rule.repaymentDay, t)}</span>
                      ) : (
                        // 没写 = 该时期沿用账户级默认值；直接标出默认值，避免看起来像漏填。
                        <span className="text-slate-400" title={t("creditBill.billingDayRuleRepaymentHint")}>
                          {accountRepaymentText
                            ? t("creditBill.billingDayRuleRepaymentInherit", { value: accountRepaymentText })
                            : "-"}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right align-middle">
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => startEditingRule(rule)}
                          disabled={billingDayRuleSaving}
                          className={`${ROW_ACTION_BUTTON_BOX_CLASS} border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-50`}
                          title={t("common.edit")}
                          aria-label={t("creditBill.billingDayRuleEdit")}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void deleteBillingDayRule(rule)}
                          disabled={billingDayRuleSaving || rule.isInitial}
                          className={`${ROW_ACTION_BUTTON_BOX_CLASS} border-slate-200 bg-white text-rose-600 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50`}
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
                  <td className="px-2 py-2 text-right align-middle">
                    <input
                      value={billingDayRuleForm.billingDay}
                      onChange={(event) => setBillingDayRuleForm((current) => ({ ...current, billingDay: event.target.value }))}
                      inputMode="numeric"
                      placeholder={t("entityForm.billingDayPlaceholder")}
                      className="form-input text-right"
                    />
                  </td>
                  <td className="px-2 py-2 text-right align-middle">
                    <input
                      value={billingDayRuleForm.repayment}
                      onChange={(event) => setBillingDayRuleForm((current) => ({ ...current, repayment: event.target.value }))}
                      inputMode="numeric"
                      placeholder={billingDayRuleForm.repaymentMode === "offset"
                        ? t("creditBill.repaymentOffsetDaysPlaceholder")
                        : t("creditBill.repaymentDayPlaceholder")}
                      title={t("creditBill.billingDayRuleRepaymentHint")}
                      className="form-input text-right"
                    />
                  </td>
                  <td className="px-3 py-2 text-right align-middle">
                    <div className="inline-flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => void saveBillingDayRule("create")}
                        disabled={billingDayRuleSaving}
                        className={`${ROW_ACTION_BUTTON_BOX_CLASS} border-slate-200 bg-white text-emerald-600 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50`}
                        title={t("common.save")}
                        aria-label={t("common.save")}
                      >
                        <Check className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={resetBillingDayRuleEditor}
                        disabled={billingDayRuleSaving}
                        className={`${ROW_ACTION_BUTTON_BOX_CLASS} border-slate-200 bg-white text-slate-500 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50`}
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
