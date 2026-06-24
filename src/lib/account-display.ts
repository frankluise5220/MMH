import type { SmartSelectOption } from "@/components/SmartSelect";
import { kindLabel } from "@/lib/account-kinds";

export type AccountDisplaySource = {
  id: string;
  name: string;
  kind: string;
  numberMasked?: string | null;
  groupId?: string | null;
  investProductType?: string | null;
  Institution?: { name: string | null; shortName?: string | null } | null;
  AccountGroup?: { id: string; name: string | null } | null;
};

export type CreditCardLabelMode = "short_last4" | "full_name";

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

export function formatDisplayInstitutionName(
  institution?: { name: string | null; shortName?: string | null } | null,
  preferShort = true,
) {
  const shortName = institution?.shortName?.trim() ?? "";
  const fullName = institution?.name?.trim() ?? "";
  if (preferShort && shortName) return shortName;
  return fullName || shortName;
}

export function formatCreditCardDisplayName(input: {
  accountName: string;
  institution?: { name: string | null; shortName?: string | null } | null;
  numberMasked?: string | null;
  mode?: CreditCardLabelMode;
}) {
  const institutionLabel = formatDisplayInstitutionName(input.institution, true);
  if (input.mode === "short_last4") {
    const last4 = (input.numberMasked ?? "").trim();
    if (institutionLabel && last4) return `${institutionLabel}${last4}`;
    if (institutionLabel) return institutionLabel;
  }
  return formatAccountDisplayName(input.accountName, formatDisplayInstitutionName(input.institution, false));
}

export function buildAccountDisplayOption(account: AccountDisplaySource, creditCardLabelMode: CreditCardLabelMode = "short_last4"): AccountDisplayOption {
  const institutionName = formatDisplayInstitutionName(account.Institution, true);
  const groupId = account.groupId ?? account.AccountGroup?.id ?? "";
  const groupName = account.AccountGroup?.name?.trim() ?? "";
  const label = account.kind === "bank_credit"
    ? formatCreditCardDisplayName({
        accountName: account.name,
        institution: account.Institution,
        numberMasked: account.numberMasked,
        mode: creditCardLabelMode,
      })
    : formatAccountDisplayName(account.name, institutionName);
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
      groups.set(account.groupId, { id: account.groupId, name: account.groupName || "未命名所有人" });
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

export function buildFlatAccountOptions(accounts: Array<Pick<AccountDisplayOption, "id" | "label" | "subLabel">>): SmartSelectOption[] {
  return accounts.map((account) => ({
    id: account.id,
    label: account.label,
    subLabel: account.subLabel,
  }));
}
