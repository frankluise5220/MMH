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

export const DEFAULT_CREDIT_CARD_LABEL_TEMPLATE = "{机构简称}·{信用卡后4位}";
export const FULL_NAME_CREDIT_CARD_LABEL_TEMPLATE = "{机构名称}·{信用卡名称}";
export const SIDEBAR_CREDIT_CARD_LABEL_TEMPLATE = "{机构简称}·{信用卡名称}·{信用卡后4位}";

export type AccountDisplayOption = {
  id: string;
  name: string;
  kind: string;
  label: string;
  selectorLabel: string;
  selectorCoreLabel: string;
  groupId: string;
  groupName: string;
  institutionName: string;
  investProductType: string | null;
  subLabel: string;
  fullLabel: string;
  hoverTitle: string;
};

function joinAccountSubLabel(parts: Array<string | null | undefined>) {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const text = part?.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result.join(" · ");
}

export function formatAccountHoverTitle(input: {
  label: string;
  groupName?: string | null;
  subLabel?: string | null;
}) {
  return joinAccountSubLabel([
    input.groupName?.trim() || "未设置所有人",
    input.label,
    input.subLabel,
  ]);
}

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

export function formatAccountSelectorLabel(input: {
  accountName: string;
  institution?: { name: string | null; shortName?: string | null } | null;
  numberMasked?: string | null;
}) {
  const accountName = input.accountName.trim();
  const institutionName = input.institution?.shortName?.trim() || input.institution?.name?.trim() || "";
  const last4 = (input.numberMasked ?? "").trim();
  const parts = [institutionName, accountName];
  if (last4 && last4 !== accountName) parts.push(last4);
  return parts.filter(Boolean).join("·").trim() || accountName;
}

export function formatAccountSelectorCoreLabel(input: {
  accountName: string;
  numberMasked?: string | null;
}) {
  const accountName = input.accountName.trim();
  const last4 = (input.numberMasked ?? "").trim();
  const parts = [accountName];
  if (last4 && last4 !== accountName) parts.push(last4);
  return parts.filter(Boolean).join("·").trim() || accountName;
}

export function formatOwnerQualifiedAccountLabel(input: {
  accountName: string;
  kind?: string | null;
  institution?: { name: string | null; shortName?: string | null } | null;
  numberMasked?: string | null;
  ownerName?: string | null;
}) {
  const ownerName = input.ownerName?.trim() ?? "";
  const accountLabel = formatAccountSelectorLabel({
    accountName: input.accountName,
    institution: input.institution,
    numberMasked: input.numberMasked,
  });
  const accountType = input.kind ? kindLabel(input.kind) : "";
  return [ownerName, accountLabel, accountType].filter(Boolean).join("·") || accountLabel;
}

export function creditCardLabelTemplateFromMode(mode: CreditCardLabelMode = "short_last4") {
  return mode === "full_name" ? FULL_NAME_CREDIT_CARD_LABEL_TEMPLATE : DEFAULT_CREDIT_CARD_LABEL_TEMPLATE;
}

export function normalizeCreditCardLabelTemplate(
  input: unknown,
  fallbackMode: CreditCardLabelMode = "short_last4",
) {
  const value = String(input ?? "").trim();
  if (!value) return creditCardLabelTemplateFromMode(fallbackMode);
  return value.slice(0, 120);
}

export function formatCreditCardDisplayName(input: {
  accountName: string;
  institution?: { name: string | null; shortName?: string | null } | null;
  numberMasked?: string | null;
  template?: string | null;
  mode?: CreditCardLabelMode;
  /** @deprecated Duplicate last-four suppression is now always on for credit cards. */
  suppressDuplicateLast4?: boolean;
}) {
  const accountName = input.accountName.trim();
  const shortInstitutionNameRaw = input.institution?.shortName?.trim() ?? "";
  const fullInstitutionName = input.institution?.name?.trim() ?? "";
  const shortInstitutionName = shortInstitutionNameRaw || fullInstitutionName;
  const institutionName = fullInstitutionName || shortInstitutionNameRaw;
  const last4Raw = (input.numberMasked ?? "").trim();
  const last4 = last4Raw && accountName.includes(last4Raw) ? "" : last4Raw;
  const template = normalizeCreditCardLabelTemplate(input.template, input.mode);

  const rendered = template
    .replaceAll("{机构简称}", shortInstitutionName)
    .replaceAll("{机构全称}", institutionName)
    .replaceAll("{机构名称}", institutionName)
    .replaceAll("{信用卡名称}", accountName)
    .replaceAll("{账户名称}", accountName)
    .replaceAll("{信用卡后4位}", last4)
    .replaceAll("{后4位}", last4)
    .replace(/[·]{2,}/g, "·")
    .replace(/(^[·\s]+|[·\s]+$)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (rendered) return rendered;

  if (input.mode === "short_last4") {
    if (shortInstitutionName && last4) return `${shortInstitutionName}·${last4}`;
    return accountName || shortInstitutionName || institutionName;
  }

  return formatAccountDisplayName(accountName, institutionName);
}

export function buildAccountDisplayOption(
  account: AccountDisplaySource,
  creditCardLabelTemplateOrMode: string | CreditCardLabelMode = DEFAULT_CREDIT_CARD_LABEL_TEMPLATE,
  options?: { suppressDuplicateCreditCardLast4?: boolean },
): AccountDisplayOption {
  const institutionName = formatDisplayInstitutionName(account.Institution, true);
  const groupId = account.groupId ?? account.AccountGroup?.id ?? "";
  const groupName = account.AccountGroup?.name?.trim() ?? "";
  const creditCardLabelTemplate = normalizeCreditCardLabelTemplate(
    creditCardLabelTemplateOrMode,
    creditCardLabelTemplateOrMode === "full_name" ? "full_name" : "short_last4",
  );

  const label =
    account.kind === "bank_credit"
      ? formatCreditCardDisplayName({
          accountName: account.name,
          institution: account.Institution,
          numberMasked: account.numberMasked,
          template: creditCardLabelTemplate,
          suppressDuplicateLast4: options?.suppressDuplicateCreditCardLast4,
        })
      : account.kind === "insurance"
        ? account.name.trim()
      : formatAccountDisplayName(account.name, institutionName);

  const selectorLabel = formatAccountSelectorLabel({
    accountName: account.name,
    institution: account.Institution,
    numberMasked: account.numberMasked,
  });
  const selectorCoreLabel = formatAccountSelectorCoreLabel({
    accountName: account.name,
    numberMasked: account.numberMasked,
  });
  const ownerQualifiedLabel = formatOwnerQualifiedAccountLabel({
    accountName: account.name,
    kind: account.kind,
    institution: account.Institution,
    numberMasked: account.numberMasked,
    ownerName: groupName,
  });

  const subLabel = kindLabel(account.kind);
  const hoverTitle = formatAccountHoverTitle({
    groupName,
    label: selectorLabel || label,
    subLabel,
  });

  return {
    id: account.id,
    name: account.name,
    kind: account.kind,
    label,
    selectorLabel,
    selectorCoreLabel,
    groupId,
    groupName,
    institutionName,
    investProductType: account.investProductType ?? null,
    subLabel,
    fullLabel: ownerQualifiedLabel,
    hoverTitle,
  };
}

export function buildGroupedAccountOptions(accounts: AccountDisplayOption[]): SmartSelectOption[] {
  const groups = new Map<string, { id: string; name: string }>();
  const grouped: AccountDisplayOption[] = [];
  const ungrouped: AccountDisplayOption[] = [];

  for (const account of accounts) {
    if (account.groupId) {
      groups.set(account.groupId, {
        id: account.groupId,
        name: account.groupName || "未命名所有人",
      });
      grouped.push(account);
    } else {
      ungrouped.push(account);
    }
  }

  const headers = Array.from(groups.values())
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"))
    .map((group) => ({ id: `group:${group.id}`, label: group.name, isHeader: true }));

  const groupedItems = grouped
    .sort((a, b) => (a.groupName + a.selectorLabel).localeCompare(b.groupName + b.selectorLabel, "zh-Hans-CN"))
    .map((account) => ({
      id: account.id,
      label: account.selectorLabel,
      subLabel: joinAccountSubLabel([account.institutionName, account.subLabel]),
      title: account.hoverTitle,
      parentId: `group:${account.groupId}`,
    }));

  const ungroupedItems = ungrouped
    .sort((a, b) => a.selectorLabel.localeCompare(b.selectorLabel, "zh-Hans-CN"))
    .map((account) => ({
      id: account.id,
      label: account.selectorLabel,
      subLabel: joinAccountSubLabel([account.institutionName, account.subLabel]),
      title: account.hoverTitle,
    }));

  return [...headers, ...groupedItems, ...ungroupedItems];
}

export function buildFlatAccountOptions(
  accounts: Array<Pick<AccountDisplayOption, "id" | "label" | "subLabel"> & {
    selectorLabel?: string;
    groupName?: string | null;
    institutionName?: string | null;
    hoverTitle?: string | null;
    title?: string | null;
    kind?: string | null;
    investProductType?: string | null;
    debtDirection?: string | null;
    institutionId?: string | null;
    currency?: string | null;
  }>,
): SmartSelectOption[] {
  return accounts.map((account) => ({
    id: account.id,
    label: account.selectorLabel ?? account.label,
    subLabel: joinAccountSubLabel([account.institutionName, account.subLabel]),
    title: account.hoverTitle ?? account.title ?? formatAccountHoverTitle({
      groupName: account.groupName,
      label: account.selectorLabel ?? account.label,
      subLabel: account.subLabel,
    }),
    kind: account.kind ?? null,
    investProductType: account.investProductType ?? null,
    debtDirection: account.debtDirection ?? null,
    institutionId: account.institutionId ?? null,
    currency: account.currency ?? null,
  }));
}
