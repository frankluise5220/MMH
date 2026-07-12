export type ImportAccountKind = "bank_debit" | "bank_credit" | "loan" | "cash" | "ewallet" | "investment" | "other" | string;

export type ImportAccountMatchSource = {
  id: string;
  name: string;
  kind?: ImportAccountKind | null;
  numberMasked?: string | null;
  Institution?: { name?: string | null; shortName?: string | null } | null;
  AccountAlias?: Array<{ alias: string }> | null;
};

export type ImportAccountMatchResult<T extends ImportAccountMatchSource> = {
  account: T | null;
  ambiguousAccounts: T[];
  targetKind: ImportAccountKind | null;
  targetBankNames: string[];
};

export const IMPORT_ACCOUNT_ID_PREFIX = "account-id:";

export function encodeImportAccountId(accountId: string) {
  return `${IMPORT_ACCOUNT_ID_PREFIX}${accountId}`;
}

export function parseImportAccountId(value?: string) {
  const text = String(value ?? "").trim();
  return text.startsWith(IMPORT_ACCOUNT_ID_PREFIX) ? text.slice(IMPORT_ACCOUNT_ID_PREFIX.length).trim() : "";
}

const BANK_ALIASES: Array<{ canonical: string; aliases: string[] }> = [
  { canonical: "工商银行", aliases: ["中国工商银行", "工行"] },
  { canonical: "农业银行", aliases: ["中国农业银行", "农行"] },
  { canonical: "中国银行", aliases: ["中行"] },
  { canonical: "建设银行", aliases: ["中国建设银行", "建行"] },
  { canonical: "交通银行", aliases: ["交行"] },
  { canonical: "招商银行", aliases: ["招行", "招商"] },
  { canonical: "中信银行", aliases: ["中信"] },
  { canonical: "光大银行", aliases: ["中国光大银行", "光大"] },
  { canonical: "华夏银行", aliases: ["华夏"] },
  { canonical: "民生银行", aliases: ["中国民生银行", "民生"] },
  { canonical: "广发银行", aliases: ["广发"] },
  { canonical: "邮储银行", aliases: ["中国邮政储蓄银行", "邮政储蓄银行", "邮政银行", "邮储"] },
  { canonical: "浦发银行", aliases: ["上海浦东发展银行", "浦发"] },
  { canonical: "兴业银行", aliases: ["兴业"] },
  { canonical: "平安银行", aliases: ["平安"] },
  { canonical: "农商银行", aliases: ["农村商业银行", "农村信用社", "农信社", "农信", "江苏农信", "江苏农商", "省农信"] },
];

const CARD_KIND_ALIASES: Array<{ kind: ImportAccountKind; aliases: string[] }> = [
  { kind: "bank_credit", aliases: ["信用卡", "贷记卡"] },
  { kind: "bank_debit", aliases: ["储蓄卡", "借记卡", "银行卡"] },
];

export function normalizeImportAccountMatchKey(value?: string) {
  return String(value ?? "")
    .trim()
    .replace(/[·•\-—_\s()[\]（）【】]/g, "")
    .toLowerCase();
}

export function extractImportAccountLast4(value?: string) {
  const matches = Array.from(String(value ?? "").matchAll(/\d{4}(?!\d)/g));
  return matches.length > 0 ? matches[matches.length - 1][0] : "";
}

function accountLast4(account: ImportAccountMatchSource) {
  const fromMasked = extractImportAccountLast4(account.numberMasked ?? "");
  if (fromMasked) return fromMasked;
  const fromName = extractImportAccountLast4(account.name);
  if (fromName) return fromName;
  for (const alias of account.AccountAlias ?? []) {
    const fromAlias = extractImportAccountLast4(alias.alias);
    if (fromAlias) return fromAlias;
  }
  return "";
}

export function buildImportAccountInputCandidates(value?: string) {
  const raw = String(value ?? "").trim();
  if (!raw) return [];
  return expandImportAccountName(raw);
}

export function buildImportAccountCandidates(account: ImportAccountMatchSource) {
  const candidates = new Set<string>();
  const institutionNames = [
    account.Institution?.name?.trim() ?? "",
    account.Institution?.shortName?.trim() ?? "",
    ...inferBankNames(account.name),
  ].filter(Boolean);
  const accountNames = [account.name.trim(), ...accountKindNames(account.kind)];
  const last4 = accountLast4(account);

  for (const name of accountNames) {
    candidates.add(name);
    for (const institutionName of institutionNames) {
      candidates.add(`${institutionName}${name}`);
      candidates.add(`${institutionName}·${name}`);
      if (last4) {
        candidates.add(`${institutionName}${name}${last4}`);
        candidates.add(`${institutionName}${name}(${last4})`);
        candidates.add(`${institutionName}·${name}·${last4}`);
      }
      for (const expandedInstitution of expandBankName(institutionName)) {
        candidates.add(`${expandedInstitution}${name}`);
        if (last4) candidates.add(`${expandedInstitution}${name}(${last4})`);
      }
    }
    if (last4) {
      candidates.add(`${name}${last4}`);
      candidates.add(`${name}(${last4})`);
    }
  }

  if (account.AccountAlias) {
    for (const alias of account.AccountAlias) {
      for (const expanded of expandImportAccountName(alias.alias)) candidates.add(expanded);
    }
  }

  for (const value of [...candidates]) {
    for (const expanded of expandImportAccountName(value)) candidates.add(expanded);
  }

  return Array.from(candidates).filter(Boolean);
}

export function resolveImportAccountIdFromList(
  accountName: string | undefined,
  accounts: ImportAccountMatchSource[],
): string | null {
  return resolveImportAccountFromList(accountName, accounts)?.id ?? null;
}

export function createImportAccountMatcher<T extends ImportAccountMatchSource>(accounts: T[]) {
  const indexed = accounts.map((account) => ({
    account,
    last4: accountLast4(account),
    keys: buildImportAccountCandidates(account).map(normalizeImportAccountMatchKey).filter(Boolean),
    bankKeys: [
      account.Institution?.name ?? "",
      account.Institution?.shortName ?? "",
      ...inferBankNames(account.name),
      ...expandBankName(account.Institution?.name ?? ""),
      ...expandBankName(account.Institution?.shortName ?? ""),
    ].map(normalizeImportAccountMatchKey).filter(Boolean),
  }));

  function bankKeyMatches(item: (typeof indexed)[number], targetBankKeys: string[]) {
    if (targetBankKeys.length === 0) return true;
    return targetBankKeys.some((targetBankKey) =>
      item.bankKeys.some((bankKey) => bankKey.includes(targetBankKey) || targetBankKey.includes(bankKey)),
    );
  }

  function result(
    account: T | null,
    ambiguousMatches: Array<(typeof indexed)[number]>,
    criteria: {
      targetKind: ImportAccountKind | null;
      targetBankNames: string[];
    },
  ): ImportAccountMatchResult<T> {
    const ambiguousAccounts = Array.from(new Map(ambiguousMatches.map((item) => [item.account.id, item.account])).values());
    return {
      account,
      ambiguousAccounts,
      targetKind: criteria.targetKind,
      targetBankNames: criteria.targetBankNames,
    };
  }

  function pickUnique(matches: Array<(typeof indexed)[number]>, criteria: {
    last4: string;
    targetKind: ImportAccountKind | null;
    targetBankKeys: string[];
  }) {
    let narrowed = matches;
    if (criteria.last4) narrowed = narrowed.filter((item) => item.last4 === criteria.last4);
    if (criteria.targetKind) narrowed = narrowed.filter((item) => !item.account.kind || item.account.kind === criteria.targetKind);
    if (criteria.targetBankKeys.length > 0) narrowed = narrowed.filter((item) => bankKeyMatches(item, criteria.targetBankKeys));
    return narrowed.length === 1 ? narrowed[0].account : null;
  }

  return (accountName: string | undefined): ImportAccountMatchResult<T> => {
    const raw = String(accountName ?? "").trim();
    if (!raw) return result(null, [], { targetKind: null, targetBankNames: [] });

    const targetKind = inferAccountKind(raw);
    const targetBankNames = inferBankNames(raw);
    const targetBankKeys = targetBankNames.map(normalizeImportAccountMatchKey);

    const directAccountId = parseImportAccountId(raw);
    if (directAccountId) {
      return result(indexed.find((item) => item.account.id === directAccountId)?.account ?? null, [], { targetKind, targetBankNames });
    }

    const targetKeys = buildImportAccountInputCandidates(raw).map(normalizeImportAccountMatchKey).filter(Boolean);
    if (targetKeys.length === 0) return result(null, [], { targetKind, targetBankNames });

    const last4 = extractImportAccountLast4(raw);

    for (const targetKey of targetKeys) {
      const exactMatches = indexed.filter((item) => item.keys.includes(targetKey));
      if (exactMatches.length > 0) {
        const narrowed = pickUnique(exactMatches, { last4, targetKind, targetBankKeys });
        if (narrowed) return result(narrowed, [], { targetKind, targetBankNames });
        if (exactMatches.length === 1 && (!targetKind || !exactMatches[0].account.kind || exactMatches[0].account.kind === targetKind)) {
          return result(exactMatches[0].account, [], { targetKind, targetBankNames });
        }
        if (!targetKind && exactMatches.length > 1) return result(null, exactMatches, { targetKind, targetBankNames });
      }
    }

    if (last4) {
      const byLast4 = indexed.filter((item) => {
        if (item.last4 !== last4) return false;
        if (targetKind && item.account.kind && targetKind !== item.account.kind) return false;
        return bankKeyMatches(item, targetBankKeys);
      });
      if (byLast4.length === 1) return result(byLast4[0].account, [], { targetKind, targetBankNames });
      if (byLast4.length > 1) return result(null, byLast4, { targetKind, targetBankNames });
    }

    if (targetKind && targetBankKeys.length > 0) {
      const byBankAndKind = indexed.filter((item) => {
        if (item.account.kind !== targetKind) return false;
        return bankKeyMatches(item, targetBankKeys);
      });
      if (byBankAndKind.length === 1) return result(byBankAndKind[0].account, [], { targetKind, targetBankNames });
      if (byBankAndKind.length > 1) return result(null, byBankAndKind, { targetKind, targetBankNames });
    }

    for (const targetKey of targetKeys) {
      const partialMatches = indexed.filter((item) =>
        item.keys.some((key) => key.length >= 3 && (targetKey.includes(key) || key.includes(targetKey))),
      );
      if (partialMatches.length === 1) return result(partialMatches[0].account, [], { targetKind, targetBankNames });
      if (partialMatches.length > 1) {
        const narrowed = pickUnique(partialMatches, { last4, targetKind, targetBankKeys });
        if (narrowed) return result(narrowed, [], { targetKind, targetBankNames });
        return result(null, partialMatches, { targetKind, targetBankNames });
      }
    }

    return result(null, [], { targetKind, targetBankNames });
  };
}

export function createImportAccountResolver<T extends ImportAccountMatchSource>(accounts: T[]) {
  const matchImportAccount = createImportAccountMatcher(accounts);
  return (accountName: string | undefined): T | null => {
    return matchImportAccount(accountName).account;
  };
}

export function resolveImportAccountFromList<T extends ImportAccountMatchSource>(
  accountName: string | undefined,
  accounts: T[],
): T | null {
  return createImportAccountResolver(accounts)(accountName);
}

function accountKindNames(kind?: ImportAccountKind | null) {
  if (kind === "bank_credit") return ["信用卡"];
  if (kind === "bank_debit") return ["储蓄卡", "借记卡"];
  return [];
}

function inferAccountKind(value: string): ImportAccountKind | null {
  const key = normalizeImportAccountMatchKey(value);
  for (const item of CARD_KIND_ALIASES) {
    if (item.aliases.some((alias) => key.includes(normalizeImportAccountMatchKey(alias)))) return item.kind;
  }
  return null;
}

function inferBankNames(value: string) {
  const key = normalizeImportAccountMatchKey(value);
  const names = new Set<string>();
  for (const item of BANK_ALIASES) {
    const variants = [item.canonical, ...item.aliases];
    if (variants.some((variant) => key.includes(normalizeImportAccountMatchKey(variant)))) {
      for (const variant of variants) names.add(variant);
    }
  }
  return Array.from(names);
}

export function expandImportBankName(value: string) {
  const key = normalizeImportAccountMatchKey(value);
  const names = new Set<string>();
  if (value.trim()) names.add(value.trim());
  for (const item of BANK_ALIASES) {
    const variants = [item.canonical, ...item.aliases];
    if (variants.some((variant) => key.includes(normalizeImportAccountMatchKey(variant)))) {
      for (const variant of variants) names.add(variant);
    }
  }
  return Array.from(names);
}

function expandBankName(value: string) {
  return expandImportBankName(value);
}

function expandImportAccountName(value: string) {
  const names = new Set<string>([value.trim()]);
  const last4 = extractImportAccountLast4(value);
  const kinds = new Set<string>();
  const banks = inferBankNames(value);
  const kind = inferAccountKind(value);
  if (kind === "bank_credit") kinds.add("信用卡");
  if (kind === "bank_debit") {
    kinds.add("储蓄卡");
    kinds.add("借记卡");
  }

  for (const bank of banks) {
    names.add(bank);
    for (const cardKind of kinds) {
      names.add(`${bank}${cardKind}`);
      if (last4) {
        names.add(`${bank}${cardKind}${last4}`);
        names.add(`${bank}${cardKind}(${last4})`);
      }
    }
  }

  return Array.from(names).filter(Boolean);
}
