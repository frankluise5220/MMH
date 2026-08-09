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

type Institution = {
  id: string;
  name: string;
  shortName?: string | null;
  type: string | null;
};

type InstitutionSettingMode = "institution" | "counterparty" | "family";

const INSTITUTION_TYPES = ["bank", "insurance", "brokerage", "payment", "ewallet"] as const;
const COUNTERPARTY_TYPES = ["person", "organization"] as const;
const FAMILY_MEMBER_TYPES = ["family_member"] as const;

const typeLabelMap: Record<string, string> = {
  family_member: "家庭成员",
  person: "往来人员",
  organization: "往来组织",
  bank: "银行",
  insurance: "保险公司",
  brokerage: "证券",
  payment: "第三方支付",
  ewallet: "钱包",
  debt: "债权债务",
  other: "其他",
};

export function SettingsInstitutionsClient({
  institutions: initialInstitutions,
  updateAction,
  mode = "institution",
}: {
  institutions: Institution[];
  updateAction: (formData: FormData) => void | { ok?: boolean; error?: string } | Promise<void | { ok?: boolean; error?: string }>;
  mode?: InstitutionSettingMode;
}) {
  const [institutions, setInstitutions] = useState<Institution[]>(initialInstitutions);
  const [showCreate, setShowCreate] = useState(false);
  const allowedTypes =
    mode === "institution" ? INSTITUTION_TYPES : mode === "family" ? FAMILY_MEMBER_TYPES : COUNTERPARTY_TYPES;
  const pageTitle = mode === "institution" ? "机构" : mode === "family" ? "家庭成员" : "往来对象";
  const pageDescription =
    mode === "institution"
      ? "维护银行、保险、券商、支付和钱包机构，供账户、账单和投资流程复用。"
      : mode === "family"
        ? "维护投保人、被保险人等家庭资料，保险和家庭资产视图共用。"
        : "维护借入借出、代付、往来款使用的人或组织。";
  const listTitle = mode === "institution" ? "机构列表" : mode === "family" ? "家庭成员列表" : "往来对象列表";
  const emptyText = mode === "institution" ? "暂无机构" : mode === "family" ? "暂无家庭成员" : "暂无往来对象";
  const deleteLabel = mode === "institution" ? "机构" : mode === "family" ? "家庭成员" : "往来对象";
  const createTitle = mode === "institution" ? "新增机构" : mode === "family" ? "新增家庭成员" : "新增往来对象";
  const createNameLabel = mode === "institution" ? "机构名称" : mode === "family" ? "家庭成员名称" : "往来对象名称";
  const createNamePlaceholder =
    mode === "institution" ? "例如：中国银行、平安保险" : mode === "family" ? "例如：张三" : "例如：张三、某某公司";

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
        actions={<SettingsPrimaryAddButton onClick={() => setShowCreate(true)}>{createTitle}</SettingsPrimaryAddButton>}
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

      <SettingsSection title={listTitle} count={visibleInstitutions.length}>
        <SettingsTable minWidth={780}>
            <thead className="sticky top-0 z-10">
              <tr>
                <SettingsTh>名称</SettingsTh>
                <SettingsTh>简称</SettingsTh>
                <SettingsTh>类型</SettingsTh>
                <SettingsTh align="right">操作</SettingsTh>
              </tr>
            </thead>
            <tbody className="text-sm">
              {visibleInstitutions.length ? visibleInstitutions.map((item) => (
                <tr key={item.id} className="hover:bg-slate-50">
                  <SettingsTd className="text-sm font-medium text-slate-800">{item.name}</SettingsTd>
                  <SettingsTd>{item.shortName?.trim() || "-"}</SettingsTd>
                  <SettingsTd>{typeLabelMap[item.type ?? "other"] ?? item.type}</SettingsTd>
                  <SettingsTd align="right">
                    <SettingsRowActions>
                      <InstitutionEditButton
                        institution={item}
                        action={updateAction}
                        title={mode === "institution" ? "编辑机构" : mode === "family" ? "编辑家庭成员" : "编辑往来对象"}
                        nameLabel={mode === "institution" ? "机构名称" : mode === "family" ? "家庭成员名称" : "往来对象名称"}
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
