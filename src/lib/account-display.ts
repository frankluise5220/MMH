import type { SmartSelectOption } from "@/components/SmartSelect";
import { kindLabel } from "@/lib/account-kinds";

export type AccountDisplaySource = {
  id: string;
  name: string;
  kind: string;
  groupId?: string | null;
  investProductType?: string | null;
  Institution?: { name: string | null } | null;
  AccountGroup?: { id: string; name: string | null } | null;
};

export type AccountDisplayOption = {
  id: string;
  name: string;
  kind: string;
  label: string;
  groupId: string;
  groupName: string;
  institutionName: string;
  investProductType: string | null;
  subLabel: string;
  fullLabel: string;
};

export function formatAccountDisplayName(accountName: string, institutionName?: string | null) {
  const account = accountName.trim();
  const institution = institutionName?.trim() ?? "";
  if (!institution) return account;
  if (!account || account === institution || account.startsWith(`${institution}·`)) return account;
  return `${institution}·${account}`;
}

export function buildAccountDisplayOption(account: AccountDisplaySource): AccountDisplayOption {
  const institutionName = account.Institution?.name?.trim() ?? "";
  const groupId = account.groupId ?? account.AccountGroup?.id ?? "";
  const groupName = account.AccountGroup?.name?.trim() ?? "";
  const label = formatAccountDisplayName(account.name, institutionName);
  const subLabel = kindLabel(account.kind);

  return {
    id: account.id,
    name: account.name,
    kind: account.kind,
    label,
    groupId,
    groupName,
    institutionName,
    investProductType: account.investProductType ?? null,
    subLabel,
    fullLabel: label,
  };
}

export function buildGroupedAccountOptions(accounts: AccountDisplayOption[]): SmartSelectOption[] {
  const groups = new Map<string, { id: string; name: string }>();
  const grouped: AccountDisplayOption[] = [];
  const ungrouped: AccountDisplayOption[] = [];

  for (const account of accounts) {
    if (account.groupId) {
      groups.set(account.groupId, { id: account.groupId, name: account.groupName || "未命名分组" });
      grouped.push(account);
    } else {
      ungrouped.push(account);
    }
  }

  const headers = Array.from(groups.values())
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"))
    .map((group) => ({ id: `group:${group.id}`, label: group.name, isHeader: true }));

  const groupedItems = grouped
    .sort((a, b) => (a.groupName + a.label).localeCompare(b.groupName + b.label, "zh-Hans-CN"))
    .map((account) => ({
      id: account.id,
      label: account.label,
      subLabel: account.subLabel,
      parentId: `group:${account.groupId}`,
    }));

  const ungroupedItems = ungrouped
    .sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN"))
    .map((account) => ({
      id: account.id,
      label: account.label,
      subLabel: account.subLabel,
    }));

  return [...headers, ...groupedItems, ...ungroupedItems];
}
