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

const INSTITUTION_TYPES = ["bank", "insurance", "brokerage", "payment", "ewallet", "other"] as const;
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

  const visibleInstitutions = useMemo(
    () => institutions.filter((item) => allowedTypes.includes((item.type ?? "other") as never)),
    [allowedTypes, institutions],
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
        actions={<SettingsPrimaryAddButton onClick={() => setShowCreate(true)}>{createTitle}</SettingsPrimaryAddButton>}
      >
        <SettingsTable minWidth={780}>
            <thead className="sticky top-0 z-10">
              <tr>
                <SettingsTh>{t("settings.institutions.name")}</SettingsTh>
                <SettingsTh>{t("settings.institutions.shortName")}</SettingsTh>
                <SettingsTh>{t("settings.institutions.type")}</SettingsTh>
                <SettingsTh align="right">{t("settings.institutions.actions")}</SettingsTh>
              </tr>
            </thead>
            <tbody className="text-sm">
              {visibleInstitutions.length ? visibleInstitutions.map((item) => (
                <tr key={item.id} className="hover:bg-slate-50">
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
                        label={`${deleteLabel}：${item.name}`}
                        entity={mode === "counterparty" ? "counterparty" : "institution"}
                        id={item.id}
                        onDeleted={() => setInstitutions((prev) => prev.filter((row) => row.id !== item.id))}
                      />
                    </SettingsRowActions>
                  </SettingsTd>
                </tr>
              )) : (
                <SettingsEmptyRow colSpan={4}>{emptyText}</SettingsEmptyRow>
              )}
            </tbody>
        </SettingsTable>
      </SettingsSection>
    </div>
  );
}
