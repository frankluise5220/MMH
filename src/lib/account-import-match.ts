export type ImportAccountKind = "bank_debit" | "bank_credit" | "loan" | "cash" | "ewallet" | "investment" | "other" | string;

export type ImportAccountMatchSource = {
  id: string;
  name: string;
  kind?: ImportAccountKind | null;
  numberMasked?: string | null;
  Institution?: { name: string | null; shortName?: string | null } | null;
  AccountAlias?: Array<{ alias: string }> | null;
};

const BANK_ALIASES: Array<{ canonical: string; aliases: string[] }> = [
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
  ].filter(Boolean);
  const accountNames = [account.name.trim(), ...accountKindNames(account.kind)];
  const last4 = String(account.numberMasked ?? "").trim();

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
  const raw = String(accountName ?? "").trim();
  if (!raw) return null;

  const targetKeys = buildImportAccountInputCandidates(raw).map(normalizeImportAccountMatchKey).filter(Boolean);
  if (targetKeys.length === 0) return null;

  const last4 = extractImportAccountLast4(raw);
  const targetKind = inferAccountKind(raw);
  const targetBankKeys = inferBankNames(raw).map(normalizeImportAccountMatchKey);
  const indexed = accounts.map((account) => ({
    account,
    keys: buildImportAccountCandidates(account).map(normalizeImportAccountMatchKey).filter(Boolean),
    bankKeys: [
      account.Institution?.name ?? "",
      account.Institution?.shortName ?? "",
      ...expandBankName(account.Institution?.name ?? ""),
      ...expandBankName(account.Institution?.shortName ?? ""),
    ].map(normalizeImportAccountMatchKey).filter(Boolean),
  }));

  for (const targetKey of targetKeys) {
    const exact = indexed.find((item) => item.keys.includes(targetKey));
    if (exact) return exact.account.id;
  }

  if (last4) {
    const byLast4 = indexed.filter((item) => {
      if (String(item.account.numberMasked ?? "").trim() !== last4) return false;
      if (targetKind && item.account.kind && targetKind !== item.account.kind) return false;
      if (targetBankKeys.length === 0) return true;
      return targetBankKeys.some((targetBankKey) =>
        item.bankKeys.some((bankKey) => bankKey.includes(targetBankKey) || targetBankKey.includes(bankKey)),
      );
    });
    if (byLast4.length === 1) return byLast4[0].account.id;
  }

  for (const targetKey of targetKeys) {
    const partial = indexed.find((item) =>
      item.keys.some((key) => key.length >= 3 && (targetKey.includes(key) || key.includes(targetKey))),
    );
    if (partial) return partial.account.id;
  }

  return null;
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

function expandBankName(value: string) {
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
