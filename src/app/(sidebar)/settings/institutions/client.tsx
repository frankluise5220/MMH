"use client";

import { useMemo, useState, useCallback, useEffect } from "react";

import { AdvancedDataTable, type AdvancedDataTableColumn } from "@/components/AdvancedDataTable";
import { EntityCreateForm } from "@/components/EntityCreateForm";
import { InstitutionEditButton } from "@/components/InstitutionEditButton";
import { SettingsDeleteButton } from "@/components/SettingsDeleteButton";
import { BasicDataSubmenuHeader } from "@/components/settings/BasicDataImportExport";
import { SettingsPrimaryAddButton } from "@/components/settings/SettingsPageScaffold";
import { fetchSettingsAccountData, notifySettingsDataChanged } from "@/lib/client/settingsCache";
import { useI18n } from "@/lib/i18n";

type Institution = {
  id: string;
  name: string;
  shortName?: string | null;
  type: string | null;
};

type InstitutionSettingMode = "institution" | "counterparty" | "family";

const INSTITUTION_TYPES = ["bank", "insurance", "brokerage", "fund_company", "payment", "other"] as const;
const COUNTERPARTY_TYPES = ["person", "organization"] as const;
const FAMILY_MEMBER_TYPES = ["family_member"] as const;

export function SettingsInstitutionsClient({
  institutions: initialInstitutions,
  updateAction,
  mode = "institution",
}: {
  institutions: Institution[];
  updateAction: (formData: FormData) => void | { ok?: boolean; error?: string } | Promise<void | { ok?: boolean; error?: string }>;
  mode?: InstitutionSettingMode;
}) {
  const { t } = useI18n();
  const [institutions, setInstitutions] = useState<Institution[]>(initialInstitutions);
  const [showCreate, setShowCreate] = useState(false);
  const [typeFilter, setTypeFilter] = useState("all");
  const allowedTypes =
    mode === "institution" ? INSTITUTION_TYPES : mode === "family" ? FAMILY_MEMBER_TYPES : COUNTERPARTY_TYPES;
  const typeLabel = useCallback(
    (type: string | null | undefined) => t(`institution.type.${type ?? "other"}`),
    [t],
  );
  const emptyText = mode === "institution" ? t("settings.institutions.empty") : mode === "family" ? t("settings.familyMembers.empty") : t("settings.counterparties.empty");
  const deleteLabel = mode === "institution" ? t("settings.institutions") : mode === "family" ? t("settings.familyMembers") : t("settings.counterparties");
  const createTitle = mode === "institution" ? t("settings.institutions.createTitle") : mode === "family" ? t("settings.familyMembers.createTitle") : t("settings.counterparties.createTitle");
  const createNameLabel = mode === "institution" ? t("settings.institutions.nameLabel") : mode === "family" ? t("settings.familyMembers.nameLabel") : t("settings.counterparties.nameLabel");
  const createNamePlaceholder =
    mode === "institution" ? t("settings.institutions.namePlaceholder") : mode === "family" ? t("settings.familyMembers.namePlaceholder") : t("settings.counterparties.namePlaceholder");
  const editTitle = mode === "institution" ? t("settings.institutions.editTitle") : mode === "family" ? t("settings.familyMembers.editTitle") : t("settings.counterparties.editTitle");

  useEffect(() => {
    setInstitutions(initialInstitutions);
  }, [initialInstitutions]);

  useEffect(() => {
    setTypeFilter("all");
  }, [mode]);

  const visibleInstitutions = useMemo(
    () => institutions.filter((item) => {
      const type = item.type ?? "other";
      return allowedTypes.includes(type as never) && (mode !== "institution" || typeFilter === "all" || type === typeFilter);
    }),
    [allowedTypes, institutions, mode, typeFilter],
  );
  const createExistingNames = visibleInstitutions.flatMap((item) => [
    item.name,
    item.shortName?.trim() || "",
  ]).filter(Boolean);

  const refreshList = useCallback(async (options?: { force?: boolean }) => {
    const data = await fetchSettingsAccountData(options).catch(() => null);
    if (mode === "counterparty") {
      if (data?.counterparties) setInstitutions(data.counterparties as Institution[]);
      return;
    }
    if (data?.institutions) setInstitutions(data.institutions as Institution[]);
  }, [mode]);

  function handleCreated() {
    setShowCreate(false);
    void notifySettingsDataChanged({ scope: "accounts", reason: `${mode}:create`, prefetch: true });
    void refreshList({ force: true });
  }

  const columns: AdvancedDataTableColumn<(typeof visibleInstitutions)[0]>[] = useMemo(() => [
    {
      key: "name",
      label: t("settings.institutions.name"),
      width: 160,
      sortValue: (row) => row.name,
      render: (row) => <span className="font-medium text-slate-800">{row.name}</span>,
    },
    {
      key: "shortName",
      label: t("settings.institutions.shortName"),
      width: 120,
      sortValue: (row) => row.shortName ?? "",
      render: (row) => <span>{row.shortName?.trim() || "-"}</span>,
    },
    {
      key: "type",
      label: t("settings.institutions.type"),
      width: 120,
      sortValue: (row) => typeLabel(row.type),
      render: (row) => <span>{typeLabel(row.type)}</span>,
    },
    {
      key: "actions",
      label: t("settings.institutions.actions"),
      width: 100,
      align: "right",
      render: (row) => (
        <div className="flex items-center justify-end gap-1">
          <InstitutionEditButton
            institution={row}
            action={updateAction}
            title={editTitle}
            nameLabel={createNameLabel}
            allowedTypes={[...allowedTypes]}
            onSaved={() => {
              void notifySettingsDataChanged({ scope: "accounts", reason: `${mode}:update`, prefetch: true });
              void refreshList({ force: true });
            }}
          />
          <SettingsDeleteButton
            label={`${deleteLabel}: ${row.name}`}
            entity={mode === "counterparty" ? "counterparty" : "institution"}
            id={row.id}
            onDeleted={() => {
              setInstitutions((prev) => prev.filter((r) => r.id !== row.id));
            }}
          />
        </div>
      ),
    },
  ], [t, typeLabel, editTitle, createNameLabel, allowedTypes, deleteLabel, updateAction, mode, refreshList]);

  return (
    <div className="space-y-4">
      <BasicDataSubmenuHeader onImported={() => void refreshList({ force: true })} />

      <EntityCreateForm
        mode="full"
        layout="modal"
        open={showCreate}
        onClose={() => setShowCreate(false)}
        entityType={mode === "counterparty" ? "counterparty" : "institution"}
        defaultType={allowedTypes[0]}
        allowedInstitutionTypes={[...allowedTypes]}
        title={createTitle}
        nameLabel={createNameLabel}
        namePlaceholder={createNamePlaceholder}
        onCreated={handleCreated}
        existingNames={createExistingNames}
      />

      <div className="flex flex-wrap items-center justify-end gap-2">
        {mode === "institution" ? (
          <label className="flex items-center gap-2 text-xs text-slate-500">
            <span>{t("settings.institutions.filterLabel")}</span>
            <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} className="h-8 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 outline-none focus:border-blue-400">
              <option value="all">{t("settings.institutions.allTypes")}</option>
              {allowedTypes.map((type) => <option key={type} value={type}>{typeLabel(type)}</option>)}
            </select>
          </label>
        ) : null}
        <SettingsPrimaryAddButton onClick={() => setShowCreate(true)}>{createTitle}</SettingsPrimaryAddButton>
      </div>

      <AdvancedDataTable
        storageKey={`mmh_settings_${mode}_table_v1`}
        columns={columns}
        rows={visibleInstitutions}
        rowKey={(row) => row.id}
        emptyText={emptyText}
        minTableWidth={500}
        showFilters={false}
      />
    </div>
  );
}
