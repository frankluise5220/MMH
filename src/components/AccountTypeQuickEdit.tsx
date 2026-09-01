"use client";

import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import { PRODUCT_TYPES, supportsCostBasisMethod } from "@/lib/investment-config";
import { fetchSettingsAccountData, notifySettingsDataChanged } from "@/lib/client/settingsCache";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { CURRENCY_OPTIONS, normalizeCurrency } from "@/lib/currency";
import { supportsTradingCalendarForAccount, TRADING_CALENDARS } from "@/lib/fund/trading-calendar";
import { isDepositAccount } from "@/lib/account-kind-utils";
import { isStockAccountInstitutionType, isStockInvestmentAccount, STOCK_ACCOUNT_INSTITUTION_ERROR } from "@/lib/account-institution-rules";
import { FIXED_ASSET_TYPES, isFixedAssetAccountLike } from "@/lib/fixed-asset";

type AccountKindValue = "cash" | "bank_debit" | "bank_credit" | "ewallet" | "deposit" | "investment" | "fixed_asset" | "loan" | "other";
type Institution = { id: string; name: string; shortName?: string | null; type?: string | null };
type Group = { id: string; name: string };
export type AccountQuickEditValue = {
  id: string; name: string; kind: string; currency?: string | null; note?: string | null;
  groupId?: string | null; institutionId?: string | null; billingDay?: number | null;
  repaymentDay?: number | null; creditLimit?: unknown; creditBillMode?: "separate" | "consolidated" | null;
  numberMasked?: string | null; investProductType?: string | null; costBasisMethod?: string | null;
  fundUnitsDecimals?: number | null; tradingCalendar?: string | null; fixedAssetType?: string | null;
  counterpartyId?: string | null; debtDirection?: string | null; isConsumerLoan?: boolean | null;
};

type AccountTypeQuickEditProps = {
  account: AccountQuickEditValue;
  accountLabel?: string;
  openSignal?: number;
  showTrigger?: boolean;
};

const ACCOUNT_KINDS: AccountKindValue[] = ["cash", "bank_debit", "bank_credit", "ewallet", "deposit", "investment", "fixed_asset", "loan", "other"];

function normalizedKind(account: AccountQuickEditValue): AccountKindValue {
  if (isFixedAssetAccountLike(account)) return "fixed_asset";
  return isDepositAccount(account) ? "deposit" : (ACCOUNT_KINDS.includes(account.kind as AccountKindValue) ? account.kind as AccountKindValue : "other");
}

function institutionMatches(kind: AccountKindValue, productType: string, institution: Institution) {
  if (isStockInvestmentAccount(kind, productType)) return isStockAccountInstitutionType(institution.type);
  if (kind === "loan") return institution.type === "debt" || institution.type === "bank";
  return institution.type !== "debt";
}

export function AccountTypeQuickEdit({ account, accountLabel, openSignal = 0, showTrigger = true }: AccountTypeQuickEditProps) {
  const { t } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [groups, setGroups] = useState<Group[]>([]);
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [form, setForm] = useState<Record<string, string>>({});

  const kind = (form.kind || normalizedKind(account)) as AccountKindValue;
  const productType = form.investProductType || "fund";
  const isFixedAssetAccount = kind === "fixed_asset" || isFixedAssetAccountLike({ kind, investProductType: productType });
  const isInvestment = kind === "investment";
  const isCredit = kind === "bank_credit";
  const supportsLastFour = isCredit || kind === "bank_debit";
  const showCostBasis = isInvestment && supportsCostBasisMethod(productType);
  const filteredInstitutions = useMemo(
    () => isFixedAssetAccount ? [] : institutions.filter((institution) => institutionMatches(kind, productType, institution)),
    [institutions, isFixedAssetAccount, kind, productType],
  );

  const resetForm = useCallback(() => {
    const nextKind = normalizedKind(account);
    setForm({
      name: account.name, kind: nextKind, note: account.note ?? "", currency: normalizeCurrency(account.currency ?? "CNY"),
      groupId: account.groupId ?? "", institutionId: account.institutionId ?? "", billingDay: account.billingDay == null ? "" : String(account.billingDay),
      repaymentDay: account.repaymentDay == null ? "" : String(account.repaymentDay), creditLimit: account.creditLimit == null ? "" : String(account.creditLimit),
      creditBillMode: account.creditBillMode === "consolidated" ? "consolidated" : "separate", numberMasked: account.numberMasked ?? "",
      investProductType: nextKind === "investment" ? account.investProductType ?? "fund" : nextKind === "fixed_asset" ? "property" : "", costBasisMethod: account.costBasisMethod ?? "moving_avg",
      fundUnitsDecimals: String(account.fundUnitsDecimals ?? 2), tradingCalendar: account.tradingCalendar ?? "cn_fund", fixedAssetType: account.fixedAssetType ?? "property",
    });
    setError("");
  }, [account]);

  const openEditor = useCallback(async () => {
    resetForm();
    setOpen(true);
    const data = await fetchSettingsAccountData().catch(() => null);
    if (data) {
      setGroups(data.groups as Group[]);
      setInstitutions(data.institutions as Institution[]);
    }
  }, [resetForm]);

  useEffect(() => {
    if (openSignal <= 0) return;
    void openEditor();
  }, [openEditor, openSignal]);

  async function save() {
    if (saving) return;
    if (!form.name?.trim()) { setError(t("settings.accounts.nameRequired")); return; }
    if (!form.groupId) { setError(t("settings.accounts.ownerRequired")); return; }
    const selectedInstitution = institutions.find((institution) => institution.id === form.institutionId);
    if (isStockInvestmentAccount(kind, productType) && (!form.institutionId || !isStockAccountInstitutionType(selectedInstitution?.type))) { setError(STOCK_ACCOUNT_INSTITUTION_ERROR); return; }
    setSaving(true);
    setError("");
    try {
      const payload = isFixedAssetAccount
        ? { ...form, kind: "investment", investProductType: "property", institutionId: "", fixedAssetType: form.fixedAssetType || "property" }
        : form;
      const response = await fetch("/api/v1/accounts", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: account.id, ...payload }) });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) throw new Error(data?.error || t("settings.accounts.saveFailed"));
      setOpen(false);
      await notifySettingsDataChanged({ scope: "accounts", reason: "account:quick-edit", prefetch: true });
      dispatchFinanceDataChanged({ reason: "account:quick-edit", accountIds: [account.id] });
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.accounts.saveFailed"));
    } finally { setSaving(false); }
  }

  const setField = (key: string, value: string) => setForm((current) => ({ ...current, [key]: value }));
  const inputClass = "h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-800 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100 disabled:bg-slate-100 disabled:text-slate-400";

  return (
    <>
      {showTrigger ? (
        <span className="page-title cursor-pointer" onDoubleClick={() => { void openEditor(); }} title={t("accountTypeQuickEdit.doubleClickTitle")}>{accountLabel || account.name}</span>
      ) : null}
      {open && typeof document !== "undefined" ? createPortal(
        <div className="fixed inset-0 z-[1000] flex items-center justify-center overflow-y-auto bg-slate-950/30 p-4" onMouseDown={() => !saving && setOpen(false)}>
          <div className="max-h-[calc(100dvh-2rem)] w-[720px] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-slate-200 bg-white p-4 shadow-xl" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold text-slate-800">{t("settings.accounts.editTitle", { name: account.name })}</h2><button type="button" className="h-8 rounded border border-slate-200 px-2 text-sm text-slate-600" onClick={() => setOpen(false)}>{t("table.close")}</button></div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
              <Field label={t("settings.accounts.name")}><input value={form.name ?? ""} onChange={(event) => setField("name", event.target.value)} className={inputClass} /></Field>
              <Field label={t("settings.accounts.type")}>{isFixedAssetAccount ? <input value={t("txForm.fixedAssetToggle")} readOnly className={`${inputClass} bg-slate-50 text-slate-500`} /> : <select value={kind} onChange={(event) => setForm((current) => ({ ...current, kind: event.target.value, institutionId: "", investProductType: event.target.value === "investment" ? current.investProductType || "fund" : event.target.value === "fixed_asset" ? "property" : "" }))} className={inputClass}>{ACCOUNT_KINDS.map((value) => <option key={value} value={value}>{t(`account.kind.${value}`)}</option>)}</select>}</Field>
              {isFixedAssetAccount && <Field label={t("fixedAssetEdit.assetType")}><select value={form.fixedAssetType || "property"} onChange={(event) => setField("fixedAssetType", event.target.value)} className={inputClass}>{FIXED_ASSET_TYPES.map((value) => <option key={value} value={value}>{t(`fixedAsset.type.${value}`)}</option>)}</select></Field>}
              <Field label={t("settings.accounts.owner")}><select value={form.groupId ?? ""} onChange={(event) => setField("groupId", event.target.value)} className={inputClass}><option value="">{t("settings.accounts.selectOwner")}</option>{groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></Field>
              {!isFixedAssetAccount && <Field label={t("settings.accounts.institution")}><select value={form.institutionId ?? ""} onChange={(event) => setField("institutionId", event.target.value)} className={inputClass}><option value="">{t("settings.accounts.selectInstitution")}</option>{filteredInstitutions.map((institution) => <option key={institution.id} value={institution.id}>{institution.shortName?.trim() || institution.name}</option>)}</select></Field>}
              <Field label={t("settings.accounts.currency")}><select value={normalizeCurrency(form.currency || "CNY")} onChange={(event) => setField("currency", event.target.value)} className={inputClass}>{CURRENCY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{t(`entityForm.currency.${option.value.toLowerCase()}`)}</option>)}</select></Field>
              {isInvestment && !isFixedAssetAccount && <Field label={t("settings.accounts.investmentAccountType")}><select value={productType} onChange={(event) => setField("investProductType", event.target.value)} className={inputClass}>{PRODUCT_TYPES.map((value) => <option key={value} value={value}>{t(`investment.product.${value}`)}</option>)}</select></Field>}
              {showCostBasis && <Field label={t("settings.accounts.costBasisMethod")}><select value={form.costBasisMethod || "moving_avg"} onChange={(event) => setField("costBasisMethod", event.target.value)} className={inputClass}><option value="moving_avg">{t("settings.accounts.movingAverage")}</option><option value="fifo">{t("settings.accounts.fifo")}</option><option value="lifo">{t("settings.accounts.lifo")}</option></select></Field>}
              {isInvestment && productType === "fund" && <Field label={t("settings.accounts.fundUnitsDecimals")}><input value={form.fundUnitsDecimals ?? "2"} onChange={(event) => setField("fundUnitsDecimals", event.target.value)} className={inputClass} inputMode="numeric" /></Field>}
              {isInvestment && supportsTradingCalendarForAccount(kind, productType) && <Field label={t("settings.accounts.tradingCalendar")}><select value={form.tradingCalendar || "cn_fund"} onChange={(event) => setField("tradingCalendar", event.target.value)} className={inputClass}>{TRADING_CALENDARS.map((value) => <option key={value} value={value}>{t(`tradingCalendar.${value}`)}</option>)}</select></Field>}
              {isCredit && <Field label={t("settings.accounts.billingDayLabel")}><input value={form.billingDay ?? ""} onChange={(event) => setField("billingDay", event.target.value)} className={inputClass} inputMode="numeric" placeholder="1-31" /></Field>}
              {isCredit && <Field label={t("settings.accounts.repaymentDayLabel")}><input value={form.repaymentDay ?? ""} onChange={(event) => setField("repaymentDay", event.target.value)} className={inputClass} inputMode="numeric" placeholder="1-31" /></Field>}
              {isCredit && <Field label={t("settings.accounts.creditLimitLabel")}><input value={form.creditLimit ?? ""} onChange={(event) => setField("creditLimit", event.target.value)} className={inputClass} /></Field>}
              {supportsLastFour && <Field label={t("settings.accounts.lastFourLabel")}><input value={form.numberMasked ?? ""} onChange={(event) => setField("numberMasked", event.target.value)} className={inputClass} /></Field>}
              {isCredit && <Field label={t("settings.accounts.billMode")}><select value={form.creditBillMode || "separate"} onChange={(event) => setField("creditBillMode", event.target.value)} className={inputClass}><option value="separate">{t("settings.accounts.separateBill")}</option><option value="consolidated">{t("settings.accounts.consolidatedBill")}</option></select></Field>}
            </div>
            <Field label={t("settings.accounts.note")}><textarea value={form.note ?? ""} onChange={(event) => setField("note", event.target.value)} className="min-h-20 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-800 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100 disabled:bg-slate-100 disabled:text-slate-400" /></Field>
            {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
            <div className="mt-4 flex justify-end gap-2"><button type="button" className="rounded border border-slate-200 px-3 py-2 text-sm text-slate-600" onClick={() => setOpen(false)} disabled={saving}>{t("common.cancel")}</button><button type="button" className="rounded bg-blue-600 px-3 py-2 text-sm text-white disabled:opacity-50" onClick={save} disabled={saving}>{saving ? t("accountTypeQuickEdit.saving") : t("common.save")}</button></div>
          </div>
        </div>, document.body,
      ) : null}
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-xs text-slate-500">{label}<span className="mt-1 block">{children}</span></label>;
}
