"use client";

import { useMemo, useState, useCallback, useEffect } from "react";

import { EntityCreateForm } from "@/components/EntityCreateForm";
import { InstitutionEditButton } from "@/components/InstitutionEditButton";
import { SettingsDeleteButton } from "@/components/SettingsDeleteButton";
import {
  SettingsEmptyRow,
  SettingsPageHeader,
  SettingsPrimaryAddButton,
  SettingsRowActions,
  SettingsSection,
  SettingsTable,
  SettingsTd,
  SettingsTh,
} from "@/components/settings/SettingsPageScaffold";
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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const allowedTypes =
    mode === "institution" ? INSTITUTION_TYPES : mode === "family" ? FAMILY_MEMBER_TYPES : COUNTERPARTY_TYPES;
  const typeLabel = (type: string | null | undefined) => t(`institution.type.${type ?? "other"}`);
  const pageTitle = mode === "institution" ? t("settings.institutions") : mode === "family" ? t("settings.familyMembers") : t("settings.counterparties");
  const pageDescription =
    mode === "institution"
      ? t("settings.institutions.description")
      : mode === "family"
        ? t("settings.familyMembers.description")
        : t("settings.counterparties.description");
  const listTitle = mode === "institution" ? t("settings.institutions.listTitle") : mode === "family" ? t("settings.familyMembers.listTitle") : t("settings.counterparties.listTitle");
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
    setSelectedIds(new Set());
  }, [mode]);

  const visibleInstitutions = useMemo(
    () => institutions.filter((item) => {
      const type = item.type ?? "other";
      return allowedTypes.includes(type as never) && (mode !== "institution" || typeFilter === "all" || type === typeFilter);
    }),
    [allowedTypes, institutions, mode, typeFilter],
  );
  const allVisibleSelected = visibleInstitutions.length > 0 && visibleInstitutions.every((item) => selectedIds.has(item.id));
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

  return (
    <div className="space-y-4">
      <SettingsPageHeader
        title={pageTitle}
        description={pageDescription}
        count={visibleInstitutions.length}
      />

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

      <SettingsSection
        title={listTitle}
        count={visibleInstitutions.length}
        actions={<div className="flex flex-wrap items-center justify-end gap-2">
          {mode === "institution" ? (
            <label className="flex items-center gap-2 text-xs text-slate-500">
              <span>{t("settings.institutions.filterLabel")}</span>
              <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} className="h-8 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 outline-none focus:border-blue-400">
                <option value="all">{t("settings.institutions.allTypes")}</option>
                {allowedTypes.map((type) => <option key={type} value={type}>{typeLabel(type)}</option>)}
              </select>
            </label>
          ) : null}
          {selectedIds.size > 0 ? <span className="text-xs text-slate-500">{t("settings.institutions.selectedCount", { count: selectedIds.size })}</span> : null}
          <SettingsPrimaryAddButton onClick={() => setShowCreate(true)}>{createTitle}</SettingsPrimaryAddButton>
        </div>}
      >
        <SettingsTable minWidth={780}>
            <thead className="sticky top-0 z-10">
              <tr>
                <SettingsTh>
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={(event) => setSelectedIds((current) => {
                      const next = new Set(current);
                      for (const item of visibleInstitutions) {
                        if (event.target.checked) next.add(item.id);
                        else next.delete(item.id);
                      }
                      return next;
                    })}
                    aria-label={t("settings.institutions.selectAll")}
                  />
                </SettingsTh>
                <SettingsTh>{t("settings.institutions.name")}</SettingsTh>
                <SettingsTh>{t("settings.institutions.shortName")}</SettingsTh>
                <SettingsTh>{t("settings.institutions.type")}</SettingsTh>
                <SettingsTh align="right">{t("settings.institutions.actions")}</SettingsTh>
              </tr>
            </thead>
            <tbody className="text-sm">
              {visibleInstitutions.length ? visibleInstitutions.map((item) => (
                <tr key={item.id} className="hover:bg-slate-50">
                  <SettingsTd className="w-10">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(item.id)}
                      onChange={(event) => setSelectedIds((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(item.id);
                        else next.delete(item.id);
                        return next;
                      })}
                      aria-label={t("settings.institutions.selectRow", { name: item.name })}
                    />
                  </SettingsTd>
                  <SettingsTd className="text-sm font-medium text-slate-800">{item.name}</SettingsTd>
                  <SettingsTd>{item.shortName?.trim() || "-"}</SettingsTd>
                  <SettingsTd>{typeLabel(item.type)}</SettingsTd>
                  <SettingsTd align="right">
                    <SettingsRowActions>
                      <InstitutionEditButton
                        institution={item}
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
                        label={`${deleteLabel}: ${item.name}`}
                        entity={mode === "counterparty" ? "counterparty" : "institution"}
                        id={item.id}
                        onDeleted={() => {
                          setInstitutions((prev) => prev.filter((row) => row.id !== item.id));
                          setSelectedIds((current) => {
                            const next = new Set(current);
                            next.delete(item.id);
                            return next;
                          });
                        }}
                      />
                    </SettingsRowActions>
                  </SettingsTd>
                </tr>
              )) : (
                <SettingsEmptyRow colSpan={5}>{emptyText}</SettingsEmptyRow>
              )}
            </tbody>
        </SettingsTable>
      </SettingsSection>
    </div>
  );
}
