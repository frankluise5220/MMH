"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Database } from "lucide-react";

import { AccountBatchImportButton } from "@/components/settings/AccountBatchImportButton";
import {
  fetchSettingsAccountData,
  getCachedSettingsAccountData,
  notifySettingsDataChanged,
  type SettingsAccountGroup,
  type SettingsCounterparty,
  type SettingsInstitution,
} from "@/lib/client/settingsCache";
import { normalizeCurrency } from "@/lib/currency";
import { useI18n } from "@/lib/i18n";

type BasicDataImportExportProps = {
  groups?: SettingsAccountGroup[];
  institutions?: SettingsInstitution[];
  counterparties?: SettingsCounterparty[];
  baseCurrency?: string;
  onImported?: () => void;
  compact?: boolean;
};

const BASIC_DATA_TABS = [
  { href: "/settings/family-members", labelKey: "settings.familyMembers" },
  { href: "/settings/counterparties", labelKey: "settings.counterparties" },
  { href: "/settings/institutions", labelKey: "settings.institutions" },
  { href: "/settings/tags", labelKey: "settings.tags" },
] as const;

function normalizeAccountData(data: Awaited<ReturnType<typeof fetchSettingsAccountData>>) {
  return {
    groups: data.groups ?? [],
    institutions: data.institutions ?? [],
    counterparties: data.counterparties ?? [],
    baseCurrency: normalizeCurrency(data.baseCurrency ?? "CNY"),
  };
}

export function BasicDataImportExport({
  groups,
  institutions,
  counterparties,
  baseCurrency,
  onImported,
  compact = false,
}: BasicDataImportExportProps) {
  const { t } = useI18n();
  const hasProvidedData = Boolean(groups && institutions && counterparties && baseCurrency);
  const [loadedData, setLoadedData] = useState<ReturnType<typeof normalizeAccountData> | null>(() => {
    const cached = getCachedSettingsAccountData();
    return cached ? normalizeAccountData(cached) : null;
  });
  const [loadFailed, setLoadFailed] = useState(false);

  const resolvedData = useMemo(() => {
    if (hasProvidedData) {
      return {
        groups: groups ?? [],
        institutions: institutions ?? [],
        counterparties: counterparties ?? [],
        baseCurrency: normalizeCurrency(baseCurrency ?? "CNY"),
      };
    }
    return loadedData;
  }, [baseCurrency, counterparties, groups, hasProvidedData, institutions, loadedData]);

  const loadData = useCallback(async (force = false) => {
    try {
      const data = await fetchSettingsAccountData({ force });
      setLoadedData(normalizeAccountData(data));
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    if (hasProvidedData) return;
    void loadData(false);
  }, [hasProvidedData, loadData]);

  const handleImported = useCallback(() => {
    void notifySettingsDataChanged({ scope: "all", reason: "basic-data:import", prefetch: true });
    void loadData(true);
    onImported?.();
  }, [loadData, onImported]);

  return (
    <div
      className={[
        "flex flex-wrap items-center justify-end gap-2",
        compact ? "" : "rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-sm",
      ].join(" ")}
    >
      <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-slate-600">
        <Database className="h-3.5 w-3.5 text-slate-400" />
        {t("settings.basicDataImportExport")}
      </span>
      {resolvedData ? (
        <AccountBatchImportButton
          groups={resolvedData.groups}
          institutions={resolvedData.institutions}
          counterparties={resolvedData.counterparties}
          baseCurrency={resolvedData.baseCurrency}
          onImported={handleImported}
        />
      ) : (
        <span className={`text-xs ${loadFailed ? "text-red-500" : "text-slate-400"}`}>
          {loadFailed ? t("settings.basicDataImportExport.loadFailed") : t("settings.basicDataImportExport.loading")}
        </span>
      )}
    </div>
  );
}

export function BasicDataTabs() {
  const pathname = usePathname();
  const { t } = useI18n();

  return (
    <nav className="flex flex-wrap items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 shadow-sm" aria-label={t("settings.basicDataSubmenu")}>
      {BASIC_DATA_TABS.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            prefetch={false}
            className={[
              "inline-flex h-8 items-center rounded-md px-3 text-xs font-medium transition-colors",
              active ? "bg-blue-50 text-blue-700 shadow-sm" : "text-slate-500 hover:bg-slate-50 hover:text-slate-800",
            ].join(" ")}
          >
            {t(item.labelKey)}
          </Link>
        );
      })}
    </nav>
  );
}

export function BasicDataSubmenuHeader({ onImported }: { onImported?: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <BasicDataTabs />
      <div className="ml-auto">
        <BasicDataImportExport compact onImported={onImported} />
      </div>
    </div>
  );
}
