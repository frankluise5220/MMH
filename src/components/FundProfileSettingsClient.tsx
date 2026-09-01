"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Building2, CalendarClock, CalendarDays, Check, CircleDollarSign, Loader2, RefreshCw, Save, X } from "lucide-react";
import Link from "next/link";

import { FundConfirmDaysPanel, type ConfirmDayRow } from "@/components/FundConfirmDaysModal";
import { FundFeeRatePanel, type FeeRateRecord } from "@/components/FundFeeRatePanel";
import { FundScheduledTasksPanel } from "@/components/FundScheduledTasksPanel";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { useI18n } from "@/lib/i18n";
import { SmartSelect, type SmartSelectOption } from "@/components/SmartSelect";

export type FundProfileSettingsData = {
  fundCode: string;
  fundName: string | null;
  fundCompany: string | null;
  custodian: string | null;
  manager: string | null;
  navDateOffset: number;
};

export type FundProfileNavigationItem = {
  fundCode: string;
  fundName: string | null;
};

type FundProfileSettingsClientProps = {
  account: {
    id: string;
    name: string;
    institutionName: string | null;
  };
  profile: FundProfileSettingsData;
  backHref?: string;
  onClose?: () => void;
  modal?: boolean;
  fundCompanyOptions?: SmartSelectOption[];
  onDirtyChange?: (dirty: boolean) => void;
  confirmDayRows?: ConfirmDayRow[];
  feeRateRows?: FeeRateRecord[];
  onProfileSaved?: (profile: FundProfileSettingsData) => void;
  onConfirmDaysSaved?: (result: { fundCode: string; rows: ConfirmDayRow[] }) => void;
  onFeeRatesSaved?: (result: { fundCode: string; rows: FeeRateRecord[] }) => void;
};

type ProfileForm = Omit<FundProfileSettingsData, "navDateOffset"> & { navDateOffset: 0 | 1 };

function toForm(profile: FundProfileSettingsData): ProfileForm {
  return {
    ...profile,
    navDateOffset: profile.navDateOffset === 1 ? 1 : 0,
  };
}

function Field({
  label,
  value,
  onChange,
  readOnly = false,
}: {
  label: string;
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
}) {
  return (
    <label className="space-y-1">
      <span className="block text-xs font-medium text-slate-600">{label}</span>
      <input
        value={value}
        readOnly={readOnly}
        onChange={(event) => onChange?.(event.target.value)}
        className={["h-7 w-full rounded-md border border-slate-200 px-2.5 text-sm outline-none focus:border-blue-400", readOnly ? "bg-slate-50 text-slate-500" : "bg-white text-slate-800"].join(" ")}
      />
    </label>
  );
}

export function FundProfileSettingsClient({ account, profile, backHref, onClose, modal = false, fundCompanyOptions = [], onDirtyChange, confirmDayRows, feeRateRows, onProfileSaved, onConfirmDaysSaved, onFeeRatesSaved }: FundProfileSettingsClientProps) {
  const { t } = useI18n();
  const [form, setForm] = useState<ProfileForm>(() => toForm(profile));
  const [dirtyFields, setDirtyFields] = useState<Set<keyof ProfileForm>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    setForm(toForm(profile));
    setDirtyFields(new Set());
    setSaveMessage("");
    setSaveError("");
  }, [profile]);

  useEffect(() => {
    onDirtyChange?.(dirtyFields.size > 0);
  }, [dirtyFields, onDirtyChange]);

  const pendingFundCompanyOption = useMemo<SmartSelectOption | null>(() => {
    const value = form.fundCompany?.trim();
    if (!value || fundCompanyOptions.some((option) => option.label.trim() === value || option.subLabel?.trim() === value)) return null;
    return { id: `new-fund-company:${encodeURIComponent(value)}`, label: value, kind: "fund_company" };
  }, [form.fundCompany, fundCompanyOptions]);

  const effectiveFundCompanyOptions = useMemo(
    () => pendingFundCompanyOption ? [pendingFundCompanyOption, ...fundCompanyOptions] : fundCompanyOptions,
    [fundCompanyOptions, pendingFundCompanyOption],
  );

  const selectedFundCompanyId = useMemo(() => {
    const value = form.fundCompany?.trim();
    if (!value) return "";
    return effectiveFundCompanyOptions.find((option) => option.label.trim() === value || option.subLabel?.trim() === value)?.id ?? "";
  }, [effectiveFundCompanyOptions, form.fundCompany]);

  const currentFundName = useMemo(() => {
    return form.fundName?.trim() || profile.fundName?.trim() || "-";
  }, [form.fundName, profile.fundName]);

  const updateField = useCallback(<K extends keyof ProfileForm>(key: K, value: ProfileForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setDirtyFields((current) => new Set(current).add(key));
    setSaveMessage("");
    setSaveError("");
  }, []);

  const fetchProfile = useCallback(async () => {
    setFetching(true);
    setSaveMessage("");
    setSaveError("");
    try {
      const response = await fetch("/api/v1/fund/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fundCode: form.fundCode, syncInstitution: false }),
      });
      const data = await response.json().catch(() => null) as {
        ok?: boolean;
        profile?: Partial<FundProfileSettingsData>;
        error?: string;
      } | null;
      if (!response.ok || !data?.ok || !data.profile) throw new Error(data?.error || t("fundSettings.profileFetchFailed"));
      const fetched = data.profile;
      setForm((current) => ({
        ...current,
        fundName: !dirtyFields.has("fundName") && fetched.fundName !== undefined ? fetched.fundName ?? null : current.fundName,
        fundCompany: !dirtyFields.has("fundCompany") && fetched.fundCompany !== undefined ? fetched.fundCompany ?? null : current.fundCompany,
        custodian: !dirtyFields.has("custodian") && fetched.custodian !== undefined ? fetched.custodian ?? null : current.custodian,
        manager: !dirtyFields.has("manager") && fetched.manager !== undefined ? fetched.manager ?? null : current.manager,
      }));
      setSaveMessage(t("fundSettings.profileFetched"));
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : t("fundSettings.profileFetchFailed"));
    } finally {
      setFetching(false);
    }
  }, [dirtyFields, form.fundCode, t]);

  const saveProfile = useCallback(async () => {
    setSaving(true);
    setSaveMessage("");
    setSaveError("");
    try {
      const response = await fetch("/api/v1/fund/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await response.json().catch(() => null) as { ok?: boolean; profile?: FundProfileSettingsData; error?: string } | null;
      if (!response.ok || !data?.ok || !data.profile) throw new Error(data?.error || t("fundSettings.profileSaveFailed"));
      setSaveMessage(t("fundSettings.profileSaved"));
      onProfileSaved?.(data.profile);
      setDirtyFields(new Set());
      dispatchFinanceDataChanged({ reason: "fund-profile:save", accountIds: [account.id] });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : t("fundSettings.profileSaveFailed"));
    } finally {
      setSaving(false);
    }
  }, [account.id, form, onProfileSaved, t]);

  const sectionClass = "rounded-lg border border-slate-200 bg-white shadow-sm";
  const sectionHeaderClass = "flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-2.5 py-1.5";
  const profileActionBar = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {saveMessage ? <span className="inline-flex items-center gap-1 text-xs text-emerald-700"><Check className="h-3.5 w-3.5" />{saveMessage}</span> : null}
      {saveError ? <span className="text-xs text-rose-600">{saveError}</span> : null}
      <button
        type="button"
        onClick={() => void fetchProfile()}
        disabled={fetching || saving}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:opacity-50"
        aria-label={fetching ? t("fundSettings.fetchingProfile") : t("fundSettings.fetchProfile")}
        title={fetching ? t("fundSettings.fetchingProfile") : t("fundSettings.fetchProfile")}
      >
        {fetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
      </button>
      <button
        type="button"
        onClick={() => void saveProfile()}
        disabled={saving || fetching}
        className="inline-flex h-7 items-center gap-1 rounded-md bg-blue-600 px-2 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        <Save className="h-3.5 w-3.5" />
        {saving ? t("fundSettings.savingProfile") : t("fundSettings.saveProfile")}
      </button>
    </div>
  );

  return (
    <div className={[modal ? "min-h-0 flex-1" : "flex min-h-0 flex-1", "flex flex-col overflow-hidden bg-slate-50/60"].join(" ")}>
      <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-xl space-y-2 px-2.5 py-2 md:px-3">
        <div className="px-0.5 py-0.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 id="fund-profile-settings-title" className="text-sm font-semibold text-slate-900">{t("fundSettings.profileSection")}</h1>
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2 text-sm">
                <div className="min-w-0 truncate font-medium text-slate-800" title={currentFundName}>
                  {currentFundName}
                </div>
                <span className="text-slate-300">/</span>
                <div className="tabular-nums text-slate-600" title={form.fundCode}>
                  {form.fundCode}
                </div>
              </div>
            </div>
            {onClose ? (
              <button type="button" onClick={onClose} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700" aria-label={t("common.cancel")} title={t("common.cancel")}>
                <X className="h-4 w-4" />
              </button>
            ) : backHref ? (
              <Link
                href={backHref}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
                aria-label={t("fundSettings.backToHolding")}
                title={t("fundSettings.backToHolding")}
              >
                <X className="h-4 w-4 rotate-45" />
              </Link>
            ) : null}
          </div>
        </div>

        <section className={sectionClass}>
          <div className={sectionHeaderClass}>
            <div className="flex min-w-0 items-center gap-2">
              <Building2 className="h-4 w-4 shrink-0 text-blue-600" />
              <h2 className="text-sm font-semibold text-slate-900">{t("fundSettings.profileSection")}</h2>
            </div>
            {profileActionBar}
          </div>
          <div className="grid gap-2 p-2.5 md:grid-cols-2">
            <Field label={t("fundSettings.fundCode")} value={form.fundCode} readOnly />
            <Field label={t("fundSettings.fundName")} value={form.fundName || ""} onChange={(value) => updateField("fundName", value || null)} />
            <label className="space-y-1">
              <span className="block text-xs font-medium text-slate-600">{t("fundSettings.fundCompany")}</span>
              <SmartSelect
                mode="single"
                value={selectedFundCompanyId}
                onChange={(id) => updateField("fundCompany", effectiveFundCompanyOptions.find((option) => option.id === id)?.label ?? null)}
                options={effectiveFundCompanyOptions}
                placeholder={t("fundSettings.fundCompanyPlaceholder")}
                behavior={{ search: true, clearable: true, density: "compact" }}
              />
            </label>
            <label className="space-y-1">
              <span className="block text-xs font-medium text-slate-600">{t("fundSettings.navDateOffset")}</span>
              <select
                value={form.navDateOffset}
                onChange={(event) => updateField("navDateOffset", event.target.value === "1" ? 1 : 0)}
                className="h-7 w-full rounded-md border border-slate-200 bg-white px-2.5 text-sm text-slate-800 outline-none focus:border-blue-400"
              >
                <option value={0}>{t("fundSettings.navDateOffsetCurrent")}</option>
                <option value={1}>{t("fundSettings.navDateOffsetPrevious")}</option>
              </select>
            </label>
          </div>
          <div className="border-t border-slate-100 p-2.5 pt-2">
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-slate-700">
              <CalendarDays className="h-3.5 w-3.5 text-blue-600" />
              {t("fundSettings.tradingSection")}
            </div>
            <FundConfirmDaysPanel
              accountId={account.id}
              initialFundCode={profile.fundCode}
              fundName={profile.fundName}
              compact
              preloadedRows={confirmDayRows}
              onSaved={(result) => {
                onConfirmDaysSaved?.(result);
                dispatchFinanceDataChanged({ reason: "fund-confirm-days:save", accountIds: [account.id] });
              }}
              hideFundColumn
            />
          </div>
        </section>

        <section className={sectionClass}>
          <div className={sectionHeaderClass}>
            <div className="flex min-w-0 items-center gap-2">
              <CircleDollarSign className="h-4 w-4 shrink-0 text-emerald-600" />
              <h2 className="text-sm font-semibold text-slate-900">{t("fundSettings.institutionSection")}</h2>
            </div>
            <span className="rounded bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
              {account.institutionName || t("fundSettings.noInstitution")}
            </span>
          </div>
          <div className="p-2.5">
            <FundFeeRatePanel
              accountId={account.id}
              initialFundCode={profile.fundCode}
              compact
              preloadedRows={feeRateRows}
              onSaved={(result) => {
                onFeeRatesSaved?.(result);
                dispatchFinanceDataChanged({ reason: "fund-fee-rate:save", accountIds: [account.id] });
              }}
              hideFundColumn
            />
          </div>
        </section>

        <section className={sectionClass}>
          <div className={sectionHeaderClass}>
            <div className="flex min-w-0 items-center gap-2">
              <CalendarClock className="h-4 w-4 shrink-0 text-indigo-600" />
              <h2 className="text-sm font-semibold text-slate-900">{t("fundSettings.scheduledTaskSection")}</h2>
            </div>
          </div>
          <div className="p-2.5">
            <FundScheduledTasksPanel accountId={account.id} fundCode={profile.fundCode} />
          </div>
        </section>
      </div>
      </div>
    </div>
  );
}
