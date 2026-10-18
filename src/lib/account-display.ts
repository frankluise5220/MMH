import type { SmartSelectOption } from "@/components/SmartSelect";
import { kindLabel } from "@/lib/account-kinds";
import { normalizeUserFacingAccountKind } from "@/lib/account-kind-utils";
import { accountCurrencyLabelText, accountNameMentionsCurrency } from "@/lib/currency";
import { FIXED_ASSET_EXPENSE_CATEGORY_NAME, isFixedAssetAccountLike } from "@/lib/fixed-asset";

export type AccountDisplaySource = {
  id: string;
  name: string;
  kind: string;
  /** 账户币种。只有非账簿本位币才出现在标签里，见 `accountCurrencyLabelText`。 */
  currency?: string | null;
  numberMasked?: string | null;
  groupId?: string | null;
  investProductType?: string | null;
  Institution?: { name: string | null; shortName?: string | null; type?: string | null } | null;
  AccountGroup?: { id: string; name: string | null } | null;
  /**
   * Linked counterparty of a loan/settlement account. Used to qualify
   * list/table labels when the account name does not already contain the
   * counterparty name; dropdown selectors keep the raw name.
   */
  Counterparty?: { name?: string | null; shortName?: string | null } | null;
};

export type CreditCardLabelMode = "short_last4" | "full_name";

/**
 * Selectable pieces of a non-sidebar account display label. The stored order is
 * the render order: the user builds the label by clicking fields in sequence.
 */
export const ACCOUNT_LABEL_FIELD_KEYS = [
  "owner",
  "institution",
  "institutionShort",
  "name",
  "last4",
  "kind",
  // 币种（2026-10-18）：只有账户币种不是账簿本位币时才渲染；父账户的币种就是
  // 本位币，所以多币种父账户本身不带币种后缀，只有币种子户带。
  "currency",
] as const;

export type AccountLabelField = (typeof ACCOUNT_LABEL_FIELD_KEYS)[number];

export const ACCOUNT_LABEL_SEPARATOR = "·";
/**
 * Legacy cookie value emitted before empty selections were migrated to the
 * default fields. It is kept only so older browsers get the default format
 * instead of a name-only label.
 */
export const EMPTY_ACCOUNT_LABEL_FIELDS_VALUE = "__empty";

/**
 * Default selection matches the documented non-sidebar format:
 * account name · card last four, with the institution added only when the
 * account name does not already contain it.
 */
export const DEFAULT_ACCOUNT_LABEL_FIELDS: AccountLabelField[] = ["institutionShort", "name", "last4", "currency"];

/**
 * Stored preference version. The currency field arrived after most users had
 * already saved a field list, so an unversioned legacy value must be upgraded
 * once — otherwise multi-currency accounts never show their currency for them.
 */
const ACCOUNT_LABEL_FIELDS_VERSION_PREFIX = "v2:";

/** Full and short institution fields are two faces of the same selector slot. */
const ACCOUNT_LABEL_FIELD_CONFLICTS: Record<string, AccountLabelField[]> = {
  institution: ["institutionShort"],
  institutionShort: ["institution"],
};

export function normalizeAccountLabelFields(
  input: unknown,
  fallback: AccountLabelField[] = DEFAULT_ACCOUNT_LABEL_FIELDS,
): AccountLabelField[] {
  const raw = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? // Field keys contain digits (`last4`), so split on separators only.
        // Splitting on "everything that is not a letter" silently drops `last4`.
        input.split(/[\s,;]+/)
      : null;
  if (!raw) return [...fallback];

  const result: AccountLabelField[] = [];
  for (const item of raw) {
    const key = String(item ?? "").trim() as AccountLabelField;
    if (!ACCOUNT_LABEL_FIELD_KEYS.includes(key)) continue;

    // Picking the full institution while the short institution is selected replaces it in place
    // instead of moving it to the end, so swapping the two faces of the
    // institution keeps the click order the user already built.
    let replaced = false;
    for (const conflict of ACCOUNT_LABEL_FIELD_CONFLICTS[key] ?? []) {
      const index = result.indexOf(conflict);
      if (index < 0) continue;
      if (!replaced) {
        result[index] = key;
        replaced = true;
      } else {
        result.splice(index, 1);
      }
    }
    if (replaced) continue;

    if (result.includes(key)) continue;
    result.push(key);
  }
  return result;
}

export function serializeAccountLabelFields(fields: AccountLabelField[]) {
  const normalized = normalizeAccountLabelFields(fields);
  // An empty selection means "not configured", not "hide every field".
  // Name-only labels are represented explicitly by the `name` field.
  const value = normalized.length === 0
    ? DEFAULT_ACCOUNT_LABEL_FIELDS.join(",")
    : normalized.join(",");
  return `${ACCOUNT_LABEL_FIELDS_VERSION_PREFIX}${value}`;
}

export function parseAccountLabelFields(value: unknown): AccountLabelField[] {
  if (typeof value !== "string" || !value.trim()) return [...DEFAULT_ACCOUNT_LABEL_FIELDS];
  const raw = value.trim();
  if (raw === EMPTY_ACCOUNT_LABEL_FIELDS_VALUE) return [...DEFAULT_ACCOUNT_LABEL_FIELDS];
  const versioned = raw.startsWith(ACCOUNT_LABEL_FIELDS_VERSION_PREFIX);
  const body = versioned ? raw.slice(ACCOUNT_LABEL_FIELDS_VERSION_PREFIX.length) : raw;
  const parsed = normalizeAccountLabelFields(body, []);
  const result = parsed.length > 0 ? parsed : [...DEFAULT_ACCOUNT_LABEL_FIELDS];
  // v2 之前存下来的字段串里不可能有 currency（那时这个字段还不存在），所以
  // 老值一律补上；v2 之后用户明确取消勾选就不再强加。
  if (!versioned && !result.includes("currency")) result.push("currency");
  return result;
}

export type AccountLabelRenderInput = {
  accountName: string;
  institution?: { name: string | null; shortName?: string | null } | null;
  numberMasked?: string | null;
  ownerName?: string | null;
  /**
   * Already-resolved account-kind text. `renderAccountLabel` stays free of i18n
   * wiring, so callers pass `kindLabel(kind, t)` when they have a translator.
   */
  kindLabelText?: string | null;
  /** 账户币种；非账簿本位币且名称里没写过时才渲染。 */
  currency?: string | null;
  /** 账簿本位币。缺省时不渲染币种（不拿 CNY 猜，避免本位币非 CNY 的账簿误标）。 */
  baseCurrency?: string | null;
  fields?: AccountLabelField[] | null;
};

/**
 * 标签里该显示的币种文本（本位币、以及名称里已写过的币种都返回空串）。
 * 抽出来是因为 `buildAccountDisplayOption` 的 hover 补全也要用同一份判断。
 */
export function resolveAccountCurrencyText(
  accountName: string | null | undefined,
  currency: string | null | undefined,
  baseCurrency: string | null | undefined,
): string {
  if (!currency) return "";
  if (accountNameMentionsCurrency(accountName, currency)) return "";
  return accountCurrencyLabelText(currency, baseCurrency);
}

/**
 * Renders an account label from the configured field list. Repeated content is
 * merged: the institution is dropped when the account name already contains it,
 * the last four digits are dropped when the account name already shows them,
 * and identical fragments never repeat.
 */
export function renderAccountLabel(input: AccountLabelRenderInput) {
  const accountName = input.accountName.trim();
  const institutionShort = input.institution?.shortName?.trim() ?? "";
  const institutionFull = input.institution?.name?.trim() ?? "";
  const ownerName = input.ownerName?.trim() ?? "";
  const last4Raw = (input.numberMasked ?? "").trim();
  const last4 = last4Raw && accountName.includes(last4Raw) ? "" : last4Raw;
  const institutionSuppressed = accountNameContainsInstitution(accountName, input.institution);
  // 币种：本位币不显示；名称里已经写了币种（子户默认名「原名 · USD」）也不再重复，
  // 否则会渲染成「… · USD · USD」。
  const currencyText = resolveAccountCurrencyText(accountName, input.currency, input.baseCurrency);
  const fields = normalizeAccountLabelFields(input.fields);

  const parts: string[] = [];
  const seen = new Set<string>();
  const push = (text: string) => {
    const value = text.trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    parts.push(value);
  };

  for (const field of fields) {
    if (field === "owner") {
      push(ownerName);
    } else if (field === "institution") {
      push(institutionSuppressed ? "" : institutionFull || institutionShort);
    } else if (field === "institutionShort") {
      push(institutionSuppressed ? "" : institutionShort || institutionFull);
    } else if (field === "name") {
      push(accountName);
    } else if (field === "last4") {
      push(last4);
    } else if (field === "kind") {
      push(input.kindLabelText ?? "");
    } else if (field === "currency") {
      push(currencyText);
    }
  }

  if (parts.length > 0) return parts.join(ACCOUNT_LABEL_SEPARATOR);
  return accountName || institutionShort || institutionFull || last4Raw || ownerName;
}

export const DEFAULT_CREDIT_CARD_LABEL_TEMPLATE = "{机构简称}·{信用卡后4位}";
export const FULL_NAME_CREDIT_CARD_LABEL_TEMPLATE = "{机构名称}·{信用卡名称}";
export const SIDEBAR_CREDIT_CARD_LABEL_TEMPLATE = "{机构简称}·{信用卡名称}·{信用卡后4位}";

export type AccountDisplayOption = {
  id: string;
  name: string;
  kind: string;
  label: string;
  /**
   * Label for data lists and table cells. It follows the configured display
   * fields exactly, so it includes the owner and the account kind when the user
   * selected them. Dropdowns keep using `selectorLabel`, which omits them
   * because the owner is already rendered as a group header and the account
   * kind as a sub-label.
   */
  listLabel: string;
  selectorLabel: string;
  selectorCoreLabel: string;
  groupId: string;
  groupName: string;
  institutionName: string;
  investProductType: string | null;
  subLabel: string;
  fullLabel: string;
  hoverTitle: string;
  /**
   * Hover title for table cells that render `listLabel`. It follows the
   * "hover shows what the cell does not show" rule: only the fields hidden by
   * the configured label (owner / account kind) are appended, and the full
   * label is used only when every configured field is already visible.
   */
  tableHoverTitle: string;
};

export type AccountTableDisplaySource = {
  name?: string | null;
  /**
   * Configured list/table label produced by `buildAccountDisplayOption`. It is
   * preferred over `selectorLabel`/`label` because those may be the
   * dropdown-oriented labels, which intentionally drop the owner and the
   * account kind.
   */
  listLabel?: string | null;
  label?: string | null;
  selectorLabel?: string | null;
  fullLabel?: string | null;
  hoverTitle?: string | null;
  tableHoverTitle?: string | null;
  title?: string | null;
  numberMasked?: string | null;
  Institution?: { name?: string | null; shortName?: string | null } | null;
};

function firstTrimmedText(parts: Array<string | null | undefined>) {
  for (const part of parts) {
    const text = part?.trim();
    if (text) return text;
  }
  return "";
}

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

/**
 * 从悬浮标题里剔除「行里已经显示」的片段（所有人通常出现在下拉右侧的
 * `subLabel` 或分组表头里，不该在悬浮里再说一遍）。
 */
export function stripVisibleHoverParts(
  hoverTitle: string | null | undefined,
  visibleParts: Array<string | null | undefined>,
): string {
  const text = String(hoverTitle ?? "").trim();
  if (!text) return "";
  const visible = visibleParts.map((part) => String(part ?? "").trim()).filter(Boolean);
  if (visible.length === 0) return text;
  return joinAccountSubLabel(
    text
      .split(ACCOUNT_LABEL_SEPARATOR)
      .map((part) => part.trim())
      .filter((part) => part && !visible.includes(part)),
  );
}

/**
 * 悬浮标题：**只补行里看不到的信息**（2026-10-18 用户裁定，与 ADT 表格同一口径）。
 *
 * 行的可见文本是 `label` + `subLabel`（下拉右侧那一列），所以 `label` 和
 * `subLabel` 本身绝不再重复；只有所有人不在可见范围里时才补上。
 */
export function formatAccountHoverTitle(input: {
  label: string;
  groupName?: string | null;
  subLabel?: string | null;
}) {
  const visible = joinAccountSubLabel([input.label, input.subLabel]);
  const groupName = input.groupName?.trim() ?? "";
  if (!groupName || visible.includes(groupName)) return "";
  return groupName;
}

function accountUsesOwnerInDisplay(account: { kind?: string | null }) {
  return account.kind !== "loan";
}

function accountNameContainsInstitution(accountName: string, institution?: { name: string | null; shortName?: string | null } | null) {
  const account = accountName.trim();
  const institutionNames = [
    institution?.shortName?.trim(),
    institution?.name?.trim(),
  ].filter((name): name is string => Boolean(name));
  return institutionNames.some((name) => account === name || account.includes(name));
}

export function formatAccountDisplayName(accountName: string, institutionName?: string | null) {
  const account = accountName.trim();
  const institution = institutionName?.trim() ?? "";
  if (!institution) return account;
  if (!account || account === institution || account.includes(institution)) return account;
  return `${institution}·${account}`;
}

/**
 * Qualifies a loan/settlement account name with its linked counterparty name
 * when the account name does not already contain it, e.g. an account named
 * "current-account" with counterparty "Li Si" renders as "Li Si·current-account".
 * The containment check is case-insensitive and covers both the short and the
 * full counterparty names. Returns the trimmed account name unchanged when
 * there is no counterparty or the name already contains one of its names.
 */
export function counterpartyQualifiedAccountName(
  accountName: string,
  counterparty?: { name?: string | null; shortName?: string | null } | null,
): string {
  const name = accountName.trim();
  if (!name) return name;
  const counterpartyShort = counterparty?.shortName?.trim() || "";
  const counterpartyFull = counterparty?.name?.trim() || "";
  const counterpartyName = counterpartyShort || counterpartyFull;
  if (!counterpartyName) return name;
  const lowerName = name.toLocaleLowerCase();
  const contained = [counterpartyShort, counterpartyFull]
    .filter(Boolean)
    .some((candidate) => {
      const lowerCandidate = candidate.toLocaleLowerCase();
      return lowerCandidate.length > 0 && (lowerName === lowerCandidate || lowerName.includes(lowerCandidate));
    });
  if (contained) return name;
  return `${counterpartyName}${ACCOUNT_LABEL_SEPARATOR}${name}`;
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
  currency?: string | null;
  baseCurrency?: string | null;
  fields?: AccountLabelField[] | null;
}) {
  // The default field list reproduces the historical selector label exactly, so
  // callers that do not pass a configuration keep their current output.
  return renderAccountLabel({
    accountName: input.accountName,
    institution: input.institution,
    numberMasked: input.numberMasked,
    currency: input.currency,
    baseCurrency: input.baseCurrency,
    fields: input.fields,
  });
}

export function formatAccountSelectorCoreLabel(input: {
  accountName: string;
  numberMasked?: string | null;
}) {
  const accountName = input.accountName.trim();
  const last4 = (input.numberMasked ?? "").trim();
  const parts = [accountName];
  if (last4 && !accountName.includes(last4)) parts.push(last4);
  return parts.filter(Boolean).join("·").trim() || accountName;
}

export function formatAccountTableLabel(
  account: AccountTableDisplaySource,
  fallback = "",
  fields?: AccountLabelField[] | null,
) {
  // `listLabel` is the configured label and wins when present. `selectorLabel`
  // is the dropdown label: it follows the configured institution/name/last-four
  // order but never contains the owner or the account kind, so preferring it
  // here silently dropped those two fields from every table.
  const provided = firstTrimmedText([account.listLabel, account.selectorLabel, account.label]);
  if (provided) return provided;
  const accountName = account.name?.trim();
  if (accountName) {
    return formatAccountSelectorLabel({
      accountName,
      institution: account.Institution
        ? {
            name: account.Institution.name ?? null,
            shortName: account.Institution.shortName ?? null,
          }
        : null,
      numberMasked: account.numberMasked,
      fields,
    });
  }
  return fallback.trim();
}

export function formatAccountTableTitle(
  account: AccountTableDisplaySource,
  fallback = "",
  fields?: AccountLabelField[] | null,
) {
  const visibleLabel = formatAccountTableLabel(account, fallback, fields);
  const title = firstTrimmedText([account.tableHoverTitle, account.hoverTitle, account.title, account.fullLabel, visibleLabel]);
  // 写死规则：hover 必须比可见标签多出信息；两者一样时返回空串，
  // 由调用方省略 title 属性，免得悬浮只是把同一句话再说一遍。
  // 比较时忽略连接符差异（`a·b` 与 `a · b` 是同一句话）。
  const normalize = (text: string) => text.replace(/[\s·・•|/\\()（）\-—_]+/g, "");
  if (!title || title === visibleLabel) return "";
  return normalize(title) === normalize(visibleLabel) ? "" : title;
}

/** 表格账户列用的「按账户 id 预渲染好的标签 / hover」查表。 */
export type AccountTableLabelLookup = {
  labels?: Map<string, string> | Record<string, string> | null;
  titles?: Map<string, string> | Record<string, string> | null;
};

function lookupAccountTableText(
  source: Map<string, string> | Record<string, string> | null | undefined,
  accountId: string | null | undefined,
) {
  if (!source || !accountId) return "";
  if (source instanceof Map) return (source.get(accountId) ?? "").trim();
  return (source[accountId] ?? "").trim();
}

/**
 * 表格账户单元格的唯一解析入口：标签与 hover 都来自同一份按「系统设置 - 显示 -
 * 账户显示格式」预渲染好的映射；查不到时才回退到原始账户名。
 *
 * 不要在表格里再手工拼 `机构 · 名称`：那样会绕过设置（这也是「表格里的账户只显示
 * 名字、hover 没有所有人/类型」的根因）。
 */
export function resolveAccountTableLabel(
  accountId: string | null | undefined,
  fallbackName: string | null | undefined,
  lookup?: AccountTableLabelLookup | null,
) {
  const label = lookupAccountTableText(lookup?.labels, accountId) || (fallbackName ?? "").trim();
  const rawTitle = lookupAccountTableText(lookup?.titles, accountId) || label;
  // 与 formatAccountTableTitle 同一条规则：hover 不比可见标签多信息时返回空串，
  // 调用方据此省略 title，避免「悬浮出来还是同一句话」。
  const title = rawTitle === label ? "" : rawTitle;
  return { label, title };
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
  ownerName?: string | null;
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
  const ownerName = input.ownerName?.trim() ?? "";
  const last4Raw = (input.numberMasked ?? "").trim();
  const last4 = last4Raw && accountName.includes(last4Raw) ? "" : last4Raw;
  const template = normalizeCreditCardLabelTemplate(input.template, input.mode);

  const rendered = template
    .replaceAll("{机构简称}", shortInstitutionName)
    .replaceAll("{机构全称}", institutionName)
    .replaceAll("{机构名称}", institutionName)
    .replaceAll("{\u6240\u6709\u4eba}", ownerName)
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
  options?: {
    suppressDuplicateCreditCardLast4?: boolean;
    fields?: AccountLabelField[] | null;
    /** 账簿本位币；不传时标签里不渲染币种。 */
    baseCurrency?: string | null;
  },
): AccountDisplayOption {
  // `fields` is the global "account display format" setting. Sidebar callers do
  // not pass it and keep the sidebar's own shape; every other list passes the
  // configured fields so all of them render identically.
  const labelFields = options?.fields ?? null;
  const baseCurrency = options?.baseCurrency ?? null;
  const isFixedAsset = isFixedAssetAccountLike(account);
  // User-facing kind: legacy deposit (`investment` + `deposit`) and fixed assets
  // (`investment` + `property`) must render as their real type, not "investment",
  // so the dropdown/table sub-label matches what the account actually is.
  const displayKind = normalizeUserFacingAccountKind(account);
  const institutionName = isFixedAsset ? "" : formatDisplayInstitutionName(account.Institution, true);
  const showOwner = accountUsesOwnerInDisplay(account);
  const groupId = showOwner ? account.groupId ?? account.AccountGroup?.id ?? "" : "";
  const groupName = showOwner ? account.AccountGroup?.name?.trim() ?? "" : "";
  // `creditCardLabelTemplateOrMode` is kept for call-site compatibility only.
  // The rendered label is now driven by `options.fields` (the account display
  // format setting), so the credit-card template string is no longer consumed
  // here; see `formatCreditCardDisplayName` for the retained template renderer.
  void creditCardLabelTemplateOrMode;

  // Insurance policies and fixed assets keep their product-name-only shape; the
  // institution/card-last-four expansion does not apply to them.
  // Loan/settlement accounts linked to a counterparty get the counterparty name
  // prefixed in list/table labels when the account name does not already
  // contain it. Dropdown selectors keep the raw name because the counterparty
  // is already rendered as a group header there.
  const accountDisplayName =
    (account.kind === "loan" || account.kind === "settlement")
      ? counterpartyQualifiedAccountName(account.name, account.Counterparty)
      : account.name.trim();
  const label =
    account.kind === "insurance" || isFixedAsset
      ? account.name.trim()
      : labelFields
        ? renderAccountLabel({
            accountName: accountDisplayName,
            institution: isFixedAsset ? null : account.Institution,
            numberMasked: account.numberMasked,
            ownerName: groupName,
            kindLabelText: kindLabel(displayKind),
            currency: account.currency,
            baseCurrency,
            fields: labelFields,
          })
        : account.kind === "bank_credit"
          ? formatAccountSelectorLabel({
              accountName: account.name,
              institution: account.Institution,
              numberMasked: account.numberMasked,
            })
          : formatAccountDisplayName(accountDisplayName, institutionName);

  const selectorLabel = formatAccountSelectorLabel({
    accountName: account.name,
    institution: isFixedAsset ? null : account.Institution,
    numberMasked: account.numberMasked,
    currency: account.currency,
    baseCurrency,
    fields: labelFields,
  });
  const selectorCoreLabel = formatAccountSelectorCoreLabel({
    accountName: account.name,
    numberMasked: account.numberMasked,
  });
  const ownerQualifiedLabel =
    account.kind === "bank_credit"
      ? label
      : isFixedAsset
        ? joinAccountSubLabel([groupName, account.name, FIXED_ASSET_EXPENSE_CATEGORY_NAME])
        : labelFields
          ? joinAccountSubLabel([
              // Owner and kind are already part of the configured label when
              // selected, so appending them again would repeat the text.
              labelFields.includes("owner") ? "" : groupName,
              label,
              labelFields.includes("kind") ? "" : kindLabel(displayKind),
            ])
          : formatOwnerQualifiedAccountLabel({
              accountName: accountDisplayName,
              kind: displayKind,
              institution: account.Institution,
              numberMasked: account.numberMasked,
              ownerName: groupName,
            });

  const subLabel = isFixedAsset ? FIXED_ASSET_EXPENSE_CATEGORY_NAME : kindLabel(displayKind);
  // 币种文本（悬浮补全用）：只看「是不是本位币」，不看名称里写没写币种。
  // 名称写的是中文（「美元现金」）时，行里并没有 ISO 代码，悬浮必须补上 `USD`，
  // 否则用户看不出这笔钱记在哪个币种上；名称里已经带 `· USD` 的情况交给下面的
  // `selectorVisibleText.includes` / `label.includes` 去重，不会渲染成两个 USD。
  const tableCurrencyText = accountCurrencyLabelText(account.currency, baseCurrency);
  // 写死规则（2026-10-18 用户裁定，与 ADT 表格同一口径）：悬浮只补「行里看不到」
  // 的信息，已经显示出来的元素不再重复。
  // - 选择器行显示 `selectorLabel` + `subLabel`（类型/所有人可能已在其中）；
  // - 表格行显示 `listLabel` + 类型列。
  const selectorVisibleText = joinAccountSubLabel([selectorLabel, subLabel]);
  const hoverParts: string[] = [];
  if (showOwner && groupName && !selectorVisibleText.includes(groupName)) hoverParts.push(groupName);
  // 名称里已经写着 `USD` 的不重复；只写中文（「美元现金」）的仍要补 ISO 代码。
  const nameShowsCurrency = Boolean(tableCurrencyText) && accountDisplayName.includes(tableCurrencyText);
  if (tableCurrencyText && !nameShowsCurrency && !selectorVisibleText.includes(tableCurrencyText)) {
    hoverParts.push(tableCurrencyText);
  }
  const hoverTitle = joinAccountSubLabel(hoverParts);

  // Table hover: show only what the configured label does not already show
  // (owner first, then the account kind). Loan/settlement accounts have no
  // AccountGroup owner — their counterparty is already merged into the
  // rendered account name.
  const tableLabelFields = labelFields ?? DEFAULT_ACCOUNT_LABEL_FIELDS;
  const tableHoverParts: string[] = [];
  if (!tableLabelFields.includes("owner") && showOwner && groupName) {
    tableHoverParts.push(groupName);
  }
  if (!tableLabelFields.includes("kind") && subLabel) {
    tableHoverParts.push(subLabel);
  }
  if (!tableLabelFields.includes("currency") && tableCurrencyText && !nameShowsCurrency && !label.includes(tableCurrencyText)) {
    tableHoverParts.push(tableCurrencyText);
  }
  const tableHoverTitle = tableHoverParts.length > 0
    ? joinAccountSubLabel(tableHoverParts)
    : "";

  return {
    id: account.id,
    name: account.name,
    kind: account.kind,
    label,
    // `label` already renders the configured fields, including the owner and
    // the account kind. Insurance policies and fixed assets stay name-only.
    listLabel: label,
    selectorLabel,
    selectorCoreLabel,
    groupId,
    groupName,
    institutionName,
    investProductType: account.investProductType ?? null,
    subLabel,
    fullLabel: ownerQualifiedLabel,
    hoverTitle,
    tableHoverTitle,
  };
}

/**
 * 下拉右侧的 `subLabel`：剔除主标签里已经出现的元素（类型/所有人/币种），
 * 保证同一个元素在一个选项行里只出现一次（2026-10-18 与 ADT 表格同口径）。
 */
export function buildOptionSubLabel(
  label: string | null | undefined,
  parts: Array<string | null | undefined>,
): string {
  const text = String(label ?? "");
  return joinAccountSubLabel(
    parts
      .map((part) => String(part ?? "").trim())
      .filter((part) => part && !text.includes(part)),
  );
}

export function buildGroupedAccountOptions(accounts: AccountDisplayOption[]): SmartSelectOption[] {
  const groups = new Map<string, { id: string; name: string }>();
  const grouped: AccountDisplayOption[] = [];
  const ungrouped: AccountDisplayOption[] = [];

  for (const account of accounts) {
    if (account.groupId && accountUsesOwnerInDisplay(account)) {
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
      subLabel: buildOptionSubLabel(account.selectorLabel, [account.subLabel]),
      // 所有人已经是分组表头，悬浮里不再重复（2026-10-18：只补行里看不到的）。
      title: stripVisibleHoverParts(account.hoverTitle, [account.groupName]),
      parentId: `group:${account.groupId}`,
    }));

  const ungroupedItems = ungrouped
    .sort((a, b) => a.selectorLabel.localeCompare(b.selectorLabel, "zh-Hans-CN"))
    .map((account) => ({
      id: account.id,
      label: account.selectorLabel,
      subLabel: buildOptionSubLabel(account.selectorLabel, [account.subLabel]),
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
    liabilityDirection?: string | null;
    institutionId?: string | null;
    currency?: string | null;
  }>,
): SmartSelectOption[] {
  return accounts.map((account) => ({
    id: account.id,
    label: account.selectorLabel ?? account.label,
    // 主标签里已有的元素（所有人/类型）不再重复到右侧。
    subLabel: buildOptionSubLabel(account.selectorLabel ?? account.label, [account.groupName, account.subLabel]),
    // 所有人已经在下拉右侧显示，悬浮里剔除（2026-10-18：只补行里看不到的）。
    title: stripVisibleHoverParts(
      account.hoverTitle ?? account.title ?? formatAccountHoverTitle({
        groupName: accountUsesOwnerInDisplay(account) ? account.groupName : null,
        label: account.selectorLabel ?? account.label,
        subLabel: account.subLabel,
      }),
      [account.groupName],
    ),
    kind: account.kind ?? null,
    investProductType: account.investProductType ?? null,
    liabilityDirection: account.liabilityDirection ?? null,
    institutionId: account.institutionId ?? null,
    currency: account.currency ?? null,
  }));
}
