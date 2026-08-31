"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import {
  FundProfileSettingsClient,
  type FundProfileNavigationItem,
  type FundProfileSettingsData,
} from "@/components/FundProfileSettingsClient";
import type { ConfirmDayRow } from "@/components/FundConfirmDaysModal";
import type { FeeRateRecord } from "@/components/FundFeeRatePanel";
import type { SmartSelectOption } from "@/components/SmartSelect";
import { useI18n } from "@/lib/i18n";

type FundProfileSettingsModalProps = {
  open: boolean;
  account: {
    id: string;
    name: string;
    institutionName: string | null;
  };
  fundCode: string;
  fallbackFundName?: string | null;
  funds?: FundProfileNavigationItem[];
  onClose: () => void;
};

type ProfileListResponse = {
  ok?: boolean;
  rows?: Array<{ fundCode: string; navDateOffset?: number }>;
  profiles?: Partial<FundProfileSettingsData>[];
  error?: string;
};

type ConfirmDaysListResponse = {
  ok?: boolean;
  rows?: ConfirmDayRow[];
  error?: string;
};

type FeeRateListResponse = {
  ok?: boolean;
  rows?: FeeRateRecord[];
  error?: string;
};

type InstitutionResponse = {
  ok?: boolean;
  institutions?: Array<{ id: string; name: string; shortName?: string | null; type?: string | null }>;
  error?: string;
};

function fallbackProfile(fundCode: string, fundName: string | null | undefined): FundProfileSettingsData {
  return {
    fundCode,
    fundName: fundName?.trim() || null,
    fundCompany: null,
    custodian: null,
    manager: null,
    navDateOffset: 0,
  };
}

function institutionOptions(rows: InstitutionResponse["institutions"] = []): SmartSelectOption[] {
  return rows.map((row) => ({
    id: row.id,
    label: row.name,
    subLabel: row.shortName?.trim() || undefined,
    kind: row.type,
  }));
}

export function FundProfileSettingsModal({ open, account, fundCode, fallbackFundName, funds = [], onClose }: FundProfileSettingsModalProps) {
  const { t } = useI18n();
  const [activeFund, setActiveFund] = useState<FundProfileNavigationItem>({ fundCode, fundName: fallbackFundName?.trim() || null });
  const [profile, setProfile] = useState<FundProfileSettingsData>(() => fallbackProfile(fundCode, fallbackFundName));
  const [fundCompanyOptions, setFundCompanyOptions] = useState<SmartSelectOption[]>([]);
  const [profilesByCode, setProfilesByCode] = useState<Record<string, FundProfileSettingsData>>({});
  const [confirmDayRows, setConfirmDayRows] = useState<ConfirmDayRow[]>([]);
  const [feeRateRows, setFeeRateRows] = useState<FeeRateRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [dirty, setDirty] = useState(false);
  const loadSequence = useRef(0);
  const preloadKey = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const initial = funds.find((item) => item.fundCode === fundCode) ?? { fundCode, fundName: fallbackFundName?.trim() || null };
    setActiveFund(initial);
    setDirty(false);
  }, [fallbackFundName, funds, fundCode, open]);

  const fundItems = useMemo(() => {
    const map = new Map<string, FundProfileNavigationItem>();
    for (const item of funds) {
      const code = item.fundCode.trim();
      if (/^\d{6}$/.test(code) && !map.has(code)) map.set(code, item);
    }
    if (/^\d{6}$/.test(fundCode) && !map.has(fundCode)) {
      map.set(fundCode, { fundCode, fundName: fallbackFundName?.trim() || null });
    }
    return Array.from(map.values());
  }, [fallbackFundName, fundCode, funds]);

  const loadAllFundSettings = useCallback(async () => {
    const sequence = ++loadSequence.current;
    const codes = fundItems.map((item) => item.fundCode);
    if (codes.length === 0) return;
    setLoading(true);
    setLoadError("");
    try {
      const [profileResponse, confirmResponse, feeResponse, institutionResponse] = await Promise.all([
        fetch("/api/v1/fund/profile?list=1&includeProfiles=1&syncInstitution=0", { cache: "no-store" }),
        fetch("/api/v1/fund/confirm-days?accountId=" + encodeURIComponent(account.id) + "&list=1", { cache: "no-store" }),
        fetch("/api/v1/fund/fee-rate?accountId=" + encodeURIComponent(account.id) + "&list=1", { cache: "no-store" }),
        fetch("/api/v1/institution?type=fund_company", { cache: "no-store" }),
      ]);
      const profileData = await profileResponse.json().catch(() => null) as ProfileListResponse | null;
      const confirmData = await confirmResponse.json().catch(() => null) as ConfirmDaysListResponse | null;
      const feeData = await feeResponse.json().catch(() => null) as FeeRateListResponse | null;
      const institutionData = await institutionResponse.json().catch(() => null) as InstitutionResponse | null;
      if (!profileResponse.ok || !profileData?.ok) throw new Error(profileData?.error || t("fundSettings.profileFetchFailed"));
      if (!confirmResponse.ok || !confirmData?.ok || !Array.isArray(confirmData.rows)) throw new Error(confirmData?.error || t("fundSettings.profileFetchFailed"));
      if (!feeResponse.ok || !feeData?.ok || !Array.isArray(feeData.rows)) throw new Error(feeData?.error || t("fundSettings.profileFetchFailed"));
      if (!institutionResponse.ok || !institutionData?.ok) throw new Error(institutionData?.error || t("fundSettings.profileFetchFailed"));
      if (sequence !== loadSequence.current) return;

      const offsetByCode = new Map((profileData.rows ?? []).map((row) => [row.fundCode, row.navDateOffset === 1 ? 1 : 0]));
      const profileRows = new Map((profileData.profiles ?? []).map((row) => {
        const item = fundItems.find((fund) => fund.fundCode === row.fundCode);
        const normalized = {
          ...fallbackProfile(row.fundCode ?? item?.fundCode ?? "", row.fundName ?? item?.fundName),
          fundName: row.fundName ?? item?.fundName ?? null,
          fundCompany: row.fundCompany ?? null,
          custodian: row.custodian ?? null,
          manager: row.manager ?? null,
          navDateOffset: row.navDateOffset === 1 ? 1 : (offsetByCode.get(row.fundCode ?? "") ?? 0),
        } satisfies FundProfileSettingsData;
        return [normalized.fundCode, normalized] as const;
      }));
      for (const item of fundItems) {
        if (!profileRows.has(item.fundCode)) {
          profileRows.set(item.fundCode, {
            ...fallbackProfile(item.fundCode, item.fundName),
            navDateOffset: offsetByCode.get(item.fundCode) ?? 0,
          });
        }
      }
      const nameByCode = new Map(fundItems.map((item) => [item.fundCode, item.fundName]));
      const mergedConfirmRows = [...(confirmData.rows ?? [])];
      for (const item of fundItems) {
        if (!mergedConfirmRows.some((row) => row.fundCode === item.fundCode)) {
          mergedConfirmRows.push({ fundCode: item.fundCode, fundName: item.fundName, days: 1, arrivalDays: 2, redeemCostDays: 1, effectiveDate: null });
        }
      }
      const mergedFeeRows = (feeData.rows ?? []).map((row) => ({ ...row, fundName: row.fundName ?? nameByCode.get(row.fundCode) ?? null }));
      setProfilesByCode(Object.fromEntries(profileRows));
      setConfirmDayRows(mergedConfirmRows);
      setFeeRateRows(mergedFeeRows);
      setFundCompanyOptions(institutionOptions(institutionData.institutions));
    } catch (error) {
      if (sequence === loadSequence.current) setLoadError(error instanceof Error ? error.message : t("fundSettings.profileFetchFailed"));
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [account.id, fundItems, t]);

  useEffect(() => {
    if (!open) {
      preloadKey.current = null;
      return;
    }
    const key = account.id + ":" + fundItems.map((item) => item.fundCode).join(",");
    if (preloadKey.current === key) return;
    preloadKey.current = key;
    void loadAllFundSettings();
  }, [account.id, fundItems, loadAllFundSettings, open]);

  useEffect(() => {
    if (!open) return;
    setProfile(profilesByCode[activeFund.fundCode] ?? fallbackProfile(activeFund.fundCode, activeFund.fundName));
  }, [activeFund, open, profilesByCode]);

  const currentIndex = useMemo(() => fundItems.findIndex((item) => item.fundCode === activeFund.fundCode), [activeFund.fundCode, fundItems]);
  const previousFund = currentIndex > 0 ? fundItems[currentIndex - 1] : null;
  const nextFund = currentIndex >= 0 && currentIndex < fundItems.length - 1 ? fundItems[currentIndex + 1] : null;

  const handleClose = useCallback(() => {
    if (dirty && !window.confirm(t("fundSettings.unsavedChanges"))) return;
    onClose();
  }, [dirty, onClose, t]);

  const handleNavigate = useCallback((fund: FundProfileNavigationItem) => {
    if (dirty && !window.confirm(t("fundSettings.unsavedChanges"))) return;
    setDirty(false);
    setActiveFund(fund);
  }, [dirty, t]);

  const handleProfileSaved = useCallback((savedProfile: FundProfileSettingsData) => {
    setProfilesByCode((current) => ({ ...current, [savedProfile.fundCode]: savedProfile }));
  }, []);

  const handleConfirmDaysSaved = useCallback((result: { fundCode: string; rows: ConfirmDayRow[] }) => {
    if (!result.fundCode) return;
    setConfirmDayRows((current) => [
      ...current.filter((row) => row.fundCode !== result.fundCode),
      ...result.rows,
    ]);
  }, []);

  const handleFeeRatesSaved = useCallback((result: { fundCode: string; rows: FeeRateRecord[] }) => {
    if (!result.fundCode) return;
    setFeeRateRows((current) => [
      ...current.filter((row) => row.fundCode !== result.fundCode),
      ...result.rows,
    ]);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") handleClose();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [handleClose, open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/40 p-2 sm:p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) handleClose();
      }}
    >
      <div
        className="relative flex h-[calc(100vh-1rem)] max-h-[calc(100vh-1rem)] w-full max-w-6xl min-h-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl sm:h-[calc(100vh-2rem)] sm:max-h-[calc(100vh-2rem)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fund-profile-settings-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <FundProfileSettingsClient
          account={account}
          profile={profile}
          onClose={handleClose}
          modal
          fundCompanyOptions={fundCompanyOptions}
          previousFund={previousFund}
          nextFund={nextFund}
          onNavigate={handleNavigate}
          onDirtyChange={setDirty}
          confirmDayRows={confirmDayRows}
          feeRateRows={feeRateRows}
          onProfileSaved={handleProfileSaved}
          onConfirmDaysSaved={handleConfirmDaysSaved}
          onFeeRatesSaved={handleFeeRatesSaved}
        />
        {loading ? (
          <div className="pointer-events-none absolute right-4 top-4 z-10 inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white/95 px-2.5 py-1.5 text-xs text-slate-500 shadow-sm">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t("common.loading")}
          </div>
        ) : null}
        {loadError ? <div className="border-t border-amber-100 bg-amber-50 px-4 py-2 text-xs text-amber-700">{loadError}</div> : null}
      </div>
    </div>
  );
}
