type ImportAccountKind = "bank_debit" | "bank_credit" | "loan" | "cash" | "ewallet" | "investment" | "other" | string;

type ImportAccountMatchSource = {
  id: string;
  name: string;
  kind?: ImportAccountKind | null;
  numberMasked?: string | null;
  Institution?: { name?: string | null; shortName?: string | null } | null;
  AccountGroup?: { name?: string | null } | null;
  AccountAlias?: Array<{ alias: string }> | null;
};

type ImportAccountMatchResult<T extends ImportAccountMatchSource> = {
  account: T | null;
  ambiguousAccounts: T[];
  targetKind: ImportAccountKind | null;
  targetBankNames: string[];
};

type ImportOwnedMoneyAccountCandidate = {
  originalName: string;
  accountName: string;
  ownerName: string;
  kind: "bank_debit" | "cash" | "ewallet" | "investment";
  investProductType?: "fund" | "money" | "wealth" | "bond";
  institutionName?: string;
  institutionDisplayName?: string;
  numberMasked?: string;
};

type ImportAccountIdentityConflictKind =
  | "account"
  | "ambiguous"
  | "kind"
  | "last4"
  | "bank";

export type ImportAccountIdentityConflict = {
  kind: ImportAccountIdentityConflictKind;
  originalText: string;
  selectedAccountId?: string;
  matchedAccountId?: string;
};

export const IMPORT_ACCOUNT_ID_PREFIX = "account-id:";

export function encodeImportAccountId(accountId: string) {
  return `${IMPORT_ACCOUNT_ID_PREFIX}${accountId}`;
}


// 财智导出的往来命名变体（XX的普通应付款/XX的普通应收款）与标准命名（XX的往来款）
// 都解析出同一往来对象。账户名保留财智原名（原来是什么就是什么），往来款属性由账户类型（kind=settlement）+往来对象体现。
const SETTLEMENT_ACCOUNT_NAME_RE = /^(.+?)的(?:往来款|普通应付款|普通应收款)$/;

/** Extract counterparty name from "XX的往来款"（含财智变体「XX的普通应付款/普通应收款」）. Returns null on no match. */
export function parseSettlementAccountName(v: string): string | null {
  const m = v.trim().match(SETTLEMENT_ACCOUNT_NAME_RE);
  return m?.[1]?.trim() ?? null;
}

/** 判断名字是否银行/机构名（如「招商银行」「京东」）——这类前缀不能当往来对象人名。 */
function isImportBankLikeName(value: string): boolean {
  const key = normalizeImportAccountMatchKey(value);
  if (!key) return false;
  return BANK_ALIASES.some((item) =>
    [item.canonical, ...item.aliases].some(
      (variant) => normalizeImportAccountMatchKey(variant) === key,
    ),
  );
}

type ImportPersonAttributedCandidate = {
  personName: string;
  restName: string;
};

export type ImportCounterAccountKind = "credit" | "loan";

/**
 * 财智转账活动类型前缀 → 对向账户类型提示：
 * 「信用卡还款|X」→ X 是信用卡账户；「网贷收回|X」→ X 是贷款账户。
 * 其余前缀（转入/转出/借入/借出/收回/返还）不在此列——右侧按既有归属规则处理。
 */
export function importCounterKindFromCategory(category: string | undefined | null): ImportCounterAccountKind | null {
  const text = String(category ?? "").trim();
  if (!text) return null;
  if (text.includes("\u4fe1\u7528\u5361\u8fd8\u6b3e") || text.includes("\u8fd8\u4fe1\u7528\u5361")) return "credit";
  if (text.includes("\u7f51\u8d37\u6536\u56de")) return "loan";
  return null;
}

/**
 * 「XX的YYY」形态且 XX 不是所有人（不在账户分组名单内）→ 可归属为往来对象 XX 的往来款账户。
 * 往来款命名变体（XX的往来款/普通应付款/普通应收款）走 parseSettlementAccountName，不在此重复。
 */
export function parseImportPersonAttributedCandidate(
  value: string | undefined | null,
  ownerNames: readonly string[],
): ImportPersonAttributedCandidate | null {
  const raw = stripImportAccountScheduleSuffix(String(value ?? "").trim());
  const match = raw.match(/^(.{2,}?)的(.{1,})$/);
  if (!match) return null;
  const personName = match[1].trim();
  const restName = match[2].trim();
  if (!personName || !restName) return null;
  if (parseSettlementAccountName(raw)) return null;
  if (isImportBankLikeName(personName)) return null;
  const personKey = normalizeImportAccountMatchKey(personName);
  if (!personKey) return null;
  const isOwner = ownerNames.some(
    (name) => normalizeImportAccountMatchKey(String(name ?? "").trim()) === personKey,
  );
  if (isOwner) return null;
  return { personName, restName };
}
/**
 * 纯人名的对向账户：招行/工行流水里转账对手就直接写「张珺」「付斌」。
 * 勾选「创建往来款账户」时，这类名字应按往来对象建结算账户（原名保留）。
 *
 * 只接受 2-4 个汉字的裸姓名，并排除机构/商户/动作词，避免把「美团」「利息」
 * 这类短词建成往来款账户。所有人（owner）不在此列——他们走「所有人账户」。
 */
const BARE_PERSON_NAME_RE = /^[\u4e00-\u9fa5]{2,4}$/;
const BARE_PERSON_NON_NAME_RE = /银行|信用社|农商|农信|信用卡|借记卡|储蓄卡|支付|钱包|商城|超市|商店|公司|集团|基金|证券|保险|营业部|支行|分行|现金|利息|手续费|服务费|管理费|工资|奖金|报销|退款|转账|汇款|还款|消费|购物|餐饮|酒店|旅行|医疗|教育|缴费|充值|提现|美团|饿了么|淘宝|天猫|京东|拼多多|抖音|快手|滴滴|携程|星巴克|肯德基|麦当劳/;

export function parseImportBarePersonName(
  value: string | undefined | null,
  ownerNames: readonly string[],
): string | null {
  const raw = stripImportAccountScheduleSuffix(String(value ?? "").trim());
  if (!BARE_PERSON_NAME_RE.test(raw)) return null;
  if (BARE_PERSON_NON_NAME_RE.test(raw)) return null;
  if (isImportBankLikeName(raw)) return null;
  const key = normalizeImportAccountMatchKey(raw);
  if (!key) return null;
  const isOwner = ownerNames.some(
    (name) => normalizeImportAccountMatchKey(String(name ?? "").trim()) === key,
  );
  return isOwner ? null : raw;
}

export function parseImportAccountId(value?: string) {
  const text = String(value ?? "").trim();
  return text.startsWith(IMPORT_ACCOUNT_ID_PREFIX) ? text.slice(IMPORT_ACCOUNT_ID_PREFIX.length).trim() : "";
}

const BANK_ALIASES: Array<{ canonical: string; aliases: string[] }> = [
  { canonical: "支付宝", aliases: ["Alipay"] },
  { canonical: "微信", aliases: ["微信支付", "WeChat", "WeChat Pay"] },
  { canonical: "\u4eac\u4e1c", aliases: ["\u4eac\u4e1c\u91d1\u878d", "\u767d\u6761", "\u4eac\u4e1c\u652f\u4ed8"] },
  { canonical: "银联", aliases: ["云闪付", "银联支付"] },
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

const ACCOUNT_KIND_ALIASES: Array<{ kind: ImportAccountKind; aliases: string[] }> = [
  { kind: "bank_credit", aliases: ["信用卡", "贷记卡"] },
  { kind: "bank_debit", aliases: ["储蓄卡", "借记卡", "银行卡", "\u4e00\u5361\u901a"] },
  { kind: "ewallet", aliases: ["\u7535\u5b50\u94b1\u5305", "\u94b1\u5305", "\u96f6\u94b1\u8d26\u6237", "\u4eac\u4e1c\u5c0f\u91d1\u5e93", "\u5c0f\u91d1\u5e93"] },
  { kind: "cash", aliases: ["现金", "现金账户"] },
  { kind: "investment", aliases: ["投资账户", "投资", "基金", "基金账户", "货币基金", "货币基金账户", "理财", "理财账户"] },
  { kind: "settlement", aliases: ["往来款"] },
];

const ACCOUNT_KIND_SEPARATOR_WORDS = [
  "\u4fe1\u7528\u5361",
  "\u8d37\u8bb0\u5361",
  "\u50a8\u84c4\u5361",
  "\u501f\u8bb0\u5361",
  "\u94f6\u884c\u5361",
];

const ACCOUNT_SCHEDULE_SUFFIX_RE = /(?:[\/／\\-]\s*\d{1,2}){2}$/;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeImportAccountMatchKey(value?: string | null) {
  return String(value ?? "")
    .trim()
    .replace(/[·•\-—_\s()[\]（）【】\u7684]/g, "")
    .toLowerCase();
}

function extractImportAccountLast4(value?: string) {
  const matches = Array.from(String(value ?? "").matchAll(/\d{4}(?!\d)/g));
  return matches.length > 0 ? matches[matches.length - 1][0] : "";
}

function isImportPaymentTailHint(value?: string | null) {
  return /^(?:付款|扣款|还款)?尾号[:：]?\s*\d{2,8}$/.test(String(value ?? "").trim());
}

export function isImportPaymentTailSourceHint(value?: string | null) {
  const text = String(value ?? "").trim();
  if (!text) return false;
  if (isImportPaymentTailHint(text)) return true;
  if (/信用卡.*尾号|尾号\s*\d{2,8}.*信用卡|贷记卡.*尾号|尾号\s*\d{2,8}.*贷记卡/.test(text)) return false;
  return /(?:付款|扣款|还款|银联转账|银联入账|自动扣款|自动还款|转账).*尾号[:：]?\s*\d{2,8}/.test(text);
}

function isImportUnionPayDebitTailSourceHint(value?: string | null) {
  const text = String(value ?? "").trim();
  if (!text) return false;
  return /银联入账|银联转账|银联代扣|银联支付|云闪付/i.test(text) && /\d{4}(?!\d)/.test(text);
}

function isBareLast4Hint(value?: string | null) {
  return /^\d{4}$/.test(String(value ?? "").trim());
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

function accountBankKeys(account: ImportAccountMatchSource) {
  return [
    account.Institution?.name ?? "",
    account.Institution?.shortName ?? "",
    ...inferBankNames(account.name),
    ...expandBankName(account.Institution?.name ?? ""),
    ...expandBankName(account.Institution?.shortName ?? ""),
  ].map(normalizeImportAccountMatchKey).filter(Boolean);
}

function accountOwnerNames(account: ImportAccountMatchSource) {
  if (account.kind === "loan" || account.kind === "settlement") return [];
  return [account.AccountGroup?.name ?? ""]
    .map((name) => name.trim())
    .filter(Boolean);
}

function accountOwnerKeys(account: ImportAccountMatchSource) {
  return accountOwnerNames(account).map(normalizeImportAccountMatchKey).filter(Boolean);
}

function stripLeadingImportOwner(value: string, ownerName: string) {
  const pattern = new RegExp(`^\\s*(?:\\u6240\\u6709\\u4eba\\s*[:\\uff1a]?\\s*)?${escapeRegExp(ownerName)}(?:\\s*\\u7684|[\\s·•_\\-—/／\\\\()[\\]\\uff08\\uff09\\u3010\\u3011:\\uff1a]+)?\\s*`);
  return value.replace(pattern, "").trim();
}

function stripImportAccountScheduleSuffix(value: string) {
  return value.replace(ACCOUNT_SCHEDULE_SUFFIX_RE, "").trim();
}

function stripImportOwnerFieldPrefix(value: string) {
  return value.replace(/^\s*\u6240\u6709\u4eba\s*[:\uff1a]?\s*/, "").trim();
}

function stripLeadingInstitutionName(value: string, institutionNames: string[]) {
  let next = value.trim();
  for (const institutionName of institutionNames.sort((a, b) => b.length - a.length)) {
    if (!institutionName) continue;
    next = next.replace(new RegExp(`^\\s*${escapeRegExp(institutionName)}(?:\\s*\\u7684|[\\s·•_\\-—/／\\\\()[\\]\\uff08\\uff09\\u3010\\u3011:\\uff1a]+)?\\s*`), "").trim();
  }
  return next;
}

function inferBankDisplayName(value: string, canonicalName?: string) {
  const key = normalizeImportAccountMatchKey(value);
  if (!key) return canonicalName;
  for (const item of BANK_ALIASES) {
    const variants = [item.canonical, ...item.aliases]
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    const matched = variants.find((variant) => key.includes(normalizeImportAccountMatchKey(variant)));
    if (matched) return matched;
  }
  return canonicalName;
}
function inferOwnedInvestmentProductType(value: string): ImportOwnedMoneyAccountCandidate["investProductType"] | null {
  if (/\u8d27\u5e01\u57fa\u91d1/.test(value)) return "money";
  if (/\u7406\u8d22/.test(value)) return "wealth";
  if (/\u57ce\u6295\u503a|\u503a\u5238/.test(value)) return "bond";
  if (/\u57fa\u91d1/.test(value)) return "fund";
  return null;
}
/**
 * 取出「纯卡号/尾号」的账户文本，返回其中的数字串（没有则返回空串）。
 * 银行流水导出常用「所有人 · 卡号/尾号」表示一个账户（如「墨斗鱼·2445」）：
 * 尾号位数并不固定（3 位、4 位、6 位、8 位都见过，也可能写成完整卡号），
 * 关键是所有人后面跟着一串数字，前缀词（尾号/卡号/账号/账户/卡）可有可无。
 */
function bareAccountTailDigits(value: string) {
  const text = String(value ?? "")
    .trim()
    .replace(/[\s:：·•\-—_\u2014\u2013/／()[\]（）【】]/g, "")
    .replace(/^(?:卡尾号|尾号|卡号|账号|账户|卡)/, "");
  return /^\d{2,20}$/.test(text) ? text : "";
}

/**
 * 账户部分只由数字/分隔符/掩码星号组成时（「****2222」「6222 0000 1111 2222」），
 * 返回其中的数字串；含字母或汉字则返回空串（那种情况保留原名当账户名）。
 */
function cardNumberDigitsOnly(value: string) {
  const text = String(value ?? "").trim();
  if (!/\d/.test(text)) return "";
  if (/[A-Za-z\u4e00-\u9fa5]/.test(text)) return "";
  const digits = text.replace(/\D/g, "");
  return /^\d{2,20}$/.test(digits) ? digits : "";
}

export function parseImportOwnedMoneyAccountCandidate(
  value: string | undefined | null,
  ownerNames: string[],
): ImportOwnedMoneyAccountCandidate | null {
  const raw = stripImportAccountScheduleSuffix(String(value ?? "").trim());
  if (!raw) return null;
  const ownerSearchText = stripImportOwnerFieldPrefix(raw);
  const rawKey = normalizeImportAccountMatchKey(ownerSearchText);
  const ownerName = ownerNames
    .map((name) => name.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .find((name) => {
      const ownerKey = normalizeImportAccountMatchKey(name);
      return ownerKey && rawKey.startsWith(ownerKey) && rawKey.length > ownerKey.length;
    });
  if (!ownerName) return null;

  const accountPart = stripLeadingImportOwner(ownerSearchText, ownerName);
  if (!accountPart) return null;
  const inferredKind = inferAccountKind(accountPart);
  if (inferredKind === "bank_credit") return null;
  const bankNames = inferBankNames(accountPart);
  const bankDisplayName = inferBankDisplayName(accountPart, bankNames[0]);
  const last4 = extractImportAccountLast4(accountPart);
  const hasBankHint = bankNames.length > 0;
  const investProductType = inferOwnedInvestmentProductType(accountPart);
  // "光大卡"这类表述：剥掉机构名后只剩"卡"字——银行名+卡的借记卡说法（无尾号、无类型词）
  const withoutInstitutionProbe = stripLeadingInstitutionName(accountPart, bankNames);
  const bareCardSuffix = withoutInstitutionProbe === "\u5361";
  // 「所有人 + 一串数字」：没有机构名、没有类型词，但账户部分就是一串卡号/尾号
  //（位数不限，3 位、6 位、完整卡号都算），按借记卡建账户。
  const bareTailDigits = bareAccountTailDigits(accountPart);
  const kind = inferredKind === "cash" || inferredKind === "ewallet" || inferredKind === "bank_debit"
    ? inferredKind
    : inferredKind === "investment" && investProductType
      ? "investment"
      : hasBankHint && (last4 || bareCardSuffix)
        ? "bank_debit"
        : bareTailDigits
          ? "bank_debit"
          : null;
  if (kind !== "bank_debit" && kind !== "cash" && kind !== "ewallet" && kind !== "investment") return null;

  const withoutInstitution = withoutInstitutionProbe;
  // 纯尾号写法（「2445」「尾号2445」「卡号:6222 0000 1111 2222」）：
  // 账户名收敛为这串数字；位数过长时（如完整卡号）只取末 4 位当名字，
  // 完整数字仍写入 numberMasked，台账里不会出现一长串数字当账户名。
  const bareTailOnly = !hasBankHint && Boolean(bareTailDigits);
  const tailNameFor = (digits: string) => (digits.length > 8 ? digits.slice(-4) : digits);
  const bareTailName = tailNameFor(bareTailDigits);
  // 带机构名的卡号写法（「招商银行 6222 0000 1111 2222」「招行****2222」）：
  // 剥掉机构名后只剩卡号，账户名同样收敛为尾号，完整数字进 numberMasked。
  const withoutInstitutionDigits = cardNumberDigitsOnly(withoutInstitution);
  const fallbackName = kind === "bank_debit"
    ? "\u501f\u8bb0\u5361"
    : kind === "ewallet"
      ? "\u7535\u5b50\u94b1\u5305"
      : kind === "investment"
        ? investProductType === "wealth"
          ? "\u7406\u8d22"
          : investProductType === "bond"
            ? "\u503a\u5238"
            : investProductType === "money"
              ? "\u8d27\u5e01\u57fa\u91d1"
              : "\u57fa\u91d1"
        : "\u73b0\u91d1";
  // "光大卡"这类银行+卡原名整体保留为账户名（与建账保留财智原名的口径一致），
  // 下次导入同文本才能精确复用已建账户；剥离后只剩"卡"不能当账户名。
  const accountName = bareCardSuffix
    ? accountPart
    : bareTailOnly
      ? bareTailName
      : withoutInstitutionDigits
        ? tailNameFor(withoutInstitutionDigits)
        : (withoutInstitution || fallbackName);
  return {
    originalName: raw,
    accountName,
    ownerName,
    kind,
    investProductType: kind === "investment" ? investProductType ?? "fund" : undefined,
    institutionName: kind === "bank_debit" || kind === "ewallet" || kind === "investment" ? bankNames[0] : undefined,
    institutionDisplayName: kind === "bank_debit" || kind === "ewallet" || kind === "investment" ? bankDisplayName : undefined,
    numberMasked: kind === "bank_debit"
      ? bareTailDigits || withoutInstitutionDigits || last4 || undefined
      : undefined,
  };
}

function bankKeyMatchesAccount(account: ImportAccountMatchSource, targetBankNames: string[]) {
  const targetBankKeys = targetBankNames.map(normalizeImportAccountMatchKey).filter(Boolean);
  if (targetBankKeys.length === 0) return true;
  const bankKeys = accountBankKeys(account);
  return targetBankKeys.some((targetBankKey) =>
    bankKeys.some((bankKey) => bankKey.includes(targetBankKey) || targetBankKey.includes(bankKey)),
  );
}


export function createImportAccountIdentityConflictChecker<T extends ImportAccountMatchSource>(accounts: T[]) {
  const matchImportAccount = createImportAccountMatcher(accounts);
  return (
    selectedAccount: T | null | undefined,
    originalText: string | undefined,
  ): ImportAccountIdentityConflict | null => {
  const original = String(originalText ?? "").trim();
  if (!original || !selectedAccount) return null;

  const directAccountId = parseImportAccountId(original);
  if (directAccountId) {
    return directAccountId === selectedAccount.id
      ? null
      : { kind: "account", originalText: original, selectedAccountId: selectedAccount.id, matchedAccountId: directAccountId };
  }

  const match = matchImportAccount(original);
  if (match.account) {
    return match.account.id === selectedAccount.id
      ? null
      : { kind: "account", originalText: original, selectedAccountId: selectedAccount.id, matchedAccountId: match.account.id };
  }

  if (match.ambiguousAccounts.length > 0) {
    return match.ambiguousAccounts.some((account) => account.id === selectedAccount.id)
      ? null
      : { kind: "ambiguous", originalText: original, selectedAccountId: selectedAccount.id };
  }

  if (match.targetKind && selectedAccount.kind && selectedAccount.kind !== match.targetKind) {
    return { kind: "kind", originalText: original, selectedAccountId: selectedAccount.id };
  }

  const originalLast4 = extractImportAccountLast4(original);
  const selectedLast4 = accountLast4(selectedAccount);
  if (originalLast4 && selectedLast4 && originalLast4 !== selectedLast4) {
    return { kind: "last4", originalText: original, selectedAccountId: selectedAccount.id };
  }

  if (match.targetBankNames.length > 0 && !bankKeyMatchesAccount(selectedAccount, match.targetBankNames)) {
    return { kind: "bank", originalText: original, selectedAccountId: selectedAccount.id };
  }

  return null;
  };
}

// Bare bank-name match keys ("招商银行"/"招行"/"招商", etc.). Account-side
// candidates still generate them so bank-only statement cells can match by
// institution, but composite input text must not collapse to these keys.
const BARE_BANK_NAME_MATCH_KEYS = new Set(
  BANK_ALIASES.flatMap((item) => [item.canonical, ...item.aliases])
    .map((name) => normalizeImportAccountMatchKey(name))
    .filter(Boolean),
);

export function buildImportAccountInputCandidates(value?: string) {
  const raw = String(value ?? "").trim();
  if (!raw) return [];
  const candidates = expandImportAccountName(raw);
  // Composite inputs such as "张四·招行·8848" must not generate bare bank-name
  // exact candidates; otherwise they can exactly match every account at that
  // bank and turn an identifiable account into a false ambiguous match.
  // Preserve the old behavior only when the input itself is a bare bank name.
  if (BARE_BANK_NAME_MATCH_KEYS.has(normalizeImportAccountMatchKey(raw))) return candidates;
  return candidates.filter(
    (candidate) => !BARE_BANK_NAME_MATCH_KEYS.has(normalizeImportAccountMatchKey(candidate)),
  );
}

export function buildImportAccountCandidates(account: ImportAccountMatchSource) {
  // Kind words ("信用卡"/"储蓄卡") must NOT become account-side match keys.
  // They are not part of the account's real name: generating composite keys
  // like `${institution}${kindName}` made a generic input such as
  // "招商银行信用卡" exactly match every credit card at that bank (and a bare
  // "信用卡" match every credit card in the book), producing huge ambiguous
  // lists. Kind + institution disambiguation is handled separately by the
  // byBankAndKind stage in createImportAccountMatcher.
  const candidates = new Set<string>();
  const institutionNames = [
    account.Institution?.name?.trim() ?? "",
    account.Institution?.shortName?.trim() ?? "",
    ...inferBankNames(account.name),
  ].filter(Boolean);
  const ownerNames = accountOwnerNames(account);
  const accountNames = [account.name.trim()];
  const last4 = accountLast4(account);

  for (const name of accountNames) {
    candidates.add(name);
    for (const ownerName of ownerNames) {
      candidates.add(`${ownerName}${name}`);
      candidates.add(`${ownerName}·${name}`);
      candidates.add(`${name}(${ownerName})`);
      candidates.add(`${name}·${ownerName}`);
      if (last4) {
        candidates.add(`${ownerName}${name}${last4}`);
        candidates.add(`${ownerName}${name}(${last4})`);
        candidates.add(`${ownerName}·${name}·${last4}`);
        candidates.add(`${name}(${ownerName})${last4}`);
        candidates.add(`${name}·${ownerName}·${last4}`);
      }
    }
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
      for (const ownerName of ownerNames) {
        candidates.add(`${institutionName}${name}(${ownerName})`);
        candidates.add(`${institutionName}·${name}(${ownerName})`);
        candidates.add(`${institutionName}${name}·${ownerName}`);
        candidates.add(`${institutionName}·${name}·${ownerName}`);
        candidates.add(`${ownerName}${institutionName}${name}`);
        candidates.add(`${ownerName}·${institutionName}·${name}`);
        candidates.add(`${ownerName}${institutionName}·${name}`);
        candidates.add(`${ownerName}·${institutionName}${name}`);
        if (last4) {
          candidates.add(`${ownerName}${institutionName}${name}${last4}`);
          candidates.add(`${ownerName}${institutionName}${name}(${last4})`);
          candidates.add(`${ownerName}·${institutionName}·${name}·${last4}`);
          candidates.add(`${institutionName}${name}(${ownerName})${last4}`);
          candidates.add(`${institutionName}·${name}(${ownerName})·${last4}`);
        }
        for (const expandedInstitution of expandBankName(institutionName)) {
          candidates.add(`${ownerName}${expandedInstitution}${name}`);
          candidates.add(`${ownerName}·${expandedInstitution}·${name}`);
          if (last4) candidates.add(`${ownerName}${expandedInstitution}${name}(${last4})`);
        }
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

type ImportAccountMatchContext = {
  /**
   * 导入来源已经确定的所有人：发起导入的账户视图（该账户的 AccountGroup），
   * 或流水文件名里的「XX的流水」。只用来给「同名但不同所有人」的账户消歧；
   * 文本自己写了所有人（「张珺的朝朝宝」）时以文本为准。
   */
  ownerName?: string | null;
};

export function createImportAccountMatcher<T extends ImportAccountMatchSource>(
  accounts: T[],
  context: ImportAccountMatchContext = {},
) {
  const contextOwnerKey = normalizeImportAccountMatchKey(context.ownerName ?? "");
  const indexed = accounts.map((account) => ({
    account,
    last4: accountLast4(account),
    keys: buildImportAccountCandidates(account).map(normalizeImportAccountMatchKey).filter(Boolean),
    ownerKeys: accountOwnerKeys(account),
    bankKeys: [
      account.Institution?.name ?? "",
      account.Institution?.shortName ?? "",
      ...inferBankNames(account.name),
      ...expandBankName(account.Institution?.name ?? ""),
      ...expandBankName(account.Institution?.shortName ?? ""),
    ].map(normalizeImportAccountMatchKey).filter(Boolean),
  }));
  /**
   * 所有人名（家庭组成员）不能当作账户识别键：它只用于收窄候选。
   * 否则输入「墨斗鱼·2445」（尾号在账本里不存在）时，宽松匹配会命中
   * 「墨斗鱼」这个 3 字键，把该所有人名下所有无尾号账户（信用卡/借记卡…）
   * 全列成候选，提示变成"账户中有 11 个墨斗鱼·2445 账户"。
   */
  const ownerOnlyKeys = new Set(indexed.flatMap((item) => item.ownerKeys).filter(Boolean));

  function bankKeyMatches(item: (typeof indexed)[number], targetBankKeys: string[]) {
    if (targetBankKeys.length === 0) return true;
    return targetBankKeys.some((targetBankKey) =>
      item.bankKeys.some((bankKey) => bankKey.includes(targetBankKey) || targetBankKey.includes(bankKey)),
    );
  }

  function ownerKeyMatches(item: (typeof indexed)[number], targetOwnerKeys: string[]) {
    if (targetOwnerKeys.length === 0) return true;
    return targetOwnerKeys.some((targetOwnerKey) => item.ownerKeys.includes(targetOwnerKey));
  }

  function inferTargetOwnerKeys(raw: string) {
    const rawText = raw.trim();
    const rawKey = normalizeImportAccountMatchKey(rawText);
    const ownerKeys = new Set<string>();
    for (const item of indexed) {
      for (const ownerKey of item.ownerKeys) {
        if (!ownerKey || rawKey === ownerKey || !rawKey.startsWith(ownerKey)) continue;
        const ownerName = accountOwnerNames(item.account).find((name) => normalizeImportAccountMatchKey(name) === ownerKey);
        if (!ownerName) continue;
        const ownerPrefix = new RegExp(`^\\s*(?:所有人\\s*[:：]?\\s*)?${escapeRegExp(ownerName)}(?:\\s*的|[\\s·•_\\-—/／\\\\()[\\]（）【】:：]|$)`);
        const restKey = rawKey.slice(ownerKey.length);
        const restHasAccountHint =
          inferBankNames(restKey).length > 0 ||
          inferAccountKind(restKey) !== null ||
          ACCOUNT_KIND_SEPARATOR_WORDS.some((word) => restKey.includes(normalizeImportAccountMatchKey(word)));
        if (ownerPrefix.test(rawText) || (restKey && restHasAccountHint)) ownerKeys.add(ownerKey);
      }
    }
    return Array.from(ownerKeys);
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

  function hasCompatibleLast4(item: (typeof indexed)[number], targetLast4: string) {
    return !targetLast4 || !item.last4 || item.last4 === targetLast4;
  }

  function pickUnique(matches: Array<(typeof indexed)[number]>, criteria: {
    last4: string;
    targetKind: ImportAccountKind | null;
    targetBankKeys: string[];
    targetOwnerKeys: string[];
  }) {
    let narrowed = matches;
    if (criteria.last4) narrowed = narrowed.filter((item) => item.last4 === criteria.last4);
    if (criteria.targetKind) narrowed = narrowed.filter((item) => !item.account.kind || item.account.kind === criteria.targetKind);
    if (criteria.targetBankKeys.length > 0) narrowed = narrowed.filter((item) => bankKeyMatches(item, criteria.targetBankKeys));
    if (criteria.targetOwnerKeys.length > 0) narrowed = narrowed.filter((item) => ownerKeyMatches(item, criteria.targetOwnerKeys));
    return narrowed.length === 1 ? narrowed[0].account : null;
  }

  function pickPaymentTailSource(matches: Array<(typeof indexed)[number]>) {
    const score = (item: (typeof indexed)[number]) => {
      const kind = item.account.kind;
      if (kind === "bank_debit") return 100;
      if (kind === "cash") return 90;
      if (kind === "ewallet") return 85;
      if (kind === "deposit") return 50;
      if (kind === "bank_credit") return 20;
      if (kind === "investment") return -50;
      if (kind === "loan" || kind === "settlement") return -60;
      return 0;
    };
    const ranked = matches
      .map((item) => ({ item, score: score(item) }))
      .sort((a, b) => b.score - a.score);
    if (ranked.length === 0) return null;
    const topScore = ranked[0].score;
    const topMatches = ranked.filter((item) => item.score === topScore);
    return topMatches.length === 1 ? topMatches[0].item.account : null;
  }

  function pickUnionPayDebitSource(matches: Array<(typeof indexed)[number]>) {
    const debitMatches = matches.filter((item) => item.account.kind === "bank_debit");
    if (debitMatches.length === 1) return debitMatches[0].account;
    return null;
  }

  function pickAlipayBalanceProduct(raw: string) {
    const key = normalizeImportAccountMatchKey(raw);
    if (!key || key.includes(normalizeImportAccountMatchKey("余利宝"))) return null;
    const isGenericAlipayInvestment =
      key.includes(normalizeImportAccountMatchKey("支付宝投资类")) ||
      key.endsWith(normalizeImportAccountMatchKey("支付宝投资")) ||
      key.includes(normalizeImportAccountMatchKey("支付宝理财类")) ||
      key.endsWith(normalizeImportAccountMatchKey("支付宝理财"));
    if (!key.includes(normalizeImportAccountMatchKey("余额宝")) && !isGenericAlipayInvestment) return null;

    const alipayKeys = expandBankName("支付宝").map(normalizeImportAccountMatchKey).filter(Boolean);
    const yuebaoKey = normalizeImportAccountMatchKey("余额宝");
    const matches = indexed.filter((item) => {
      if (item.account.kind && item.account.kind !== "ewallet") return false;
      if (!bankKeyMatches(item, alipayKeys)) return false;
      return item.keys.some((candidateKey) => candidateKey === yuebaoKey || candidateKey.includes(yuebaoKey));
    });
    return matches.length === 1 ? matches[0].account : null;
  }

  function pickUniqueThirdPartyPaymentProduct(raw: string) {
    const key = normalizeImportAccountMatchKey(raw);
    if (!key) return null;
    const productGroups = [
      {
        bank: "\u5fae\u4fe1",
        aliases: ["\u5fae\u4fe1\u96f6\u94b1\u901a", "\u5fae\u4fe1\u96f6\u94b1\u5b9d", "\u96f6\u94b1\u901a", "\u96f6\u94b1\u5b9d"],
      },
      {
        bank: "\u5fae\u4fe1",
        aliases: ["\u5fae\u4fe1\u96f6\u94b1", "\u96f6\u94b1"],
        excludes: ["\u96f6\u94b1\u901a", "\u96f6\u94b1\u5b9d"],
      },
      {
        bank: "\u652f\u4ed8\u5b9d",
        aliases: ["\u652f\u4ed8\u5b9d\u4f59\u989d\u5b9d", "\u4f59\u989d\u5b9d"],
      },
      {
        bank: "\u652f\u4ed8\u5b9d",
        aliases: ["\u652f\u4ed8\u5b9d\u4f59\u989d", "\u8d26\u6237\u4f59\u989d", "\u4f59\u989d"],
        excludes: ["\u4f59\u989d\u5b9d"],
      },
      {
        bank: "\u652f\u4ed8\u5b9d",
        aliases: ["\u652f\u4ed8\u5b9d\u82b1\u5457", "\u82b1\u5457"],
      },
      {
        bank: "\u4eac\u4e1c",
        aliases: ["\u4eac\u4e1c\u5c0f\u91d1\u5e93", "\u5c0f\u91d1\u5e93"],
        targetKind: "ewallet",
      },
      {
        bank: "\u4eac\u4e1c\u91d1\u878d",
        aliases: ["\u4eac\u4e1c\u767d\u6761", "\u767d\u6761"],
      },
    ];

    for (const group of productGroups) {
      const aliasKeys = group.aliases.map(normalizeImportAccountMatchKey).filter(Boolean);
      if (!aliasKeys.some((aliasKey) => key.includes(aliasKey))) continue;
      const excludeKeys = (group.excludes ?? []).map(normalizeImportAccountMatchKey).filter(Boolean);
      if (excludeKeys.some((excludeKey) => key.includes(excludeKey))) continue;

      const bankKeys = expandBankName(group.bank).map(normalizeImportAccountMatchKey).filter(Boolean);
      const matches = indexed.filter((item) =>
        (!group.targetKind || item.account.kind === group.targetKind) &&
        bankKeyMatches(item, bankKeys) &&
        item.keys.some((candidateKey) => aliasKeys.includes(candidateKey)),
      );
      if (matches.length === 1) return matches[0].account;
      if (matches.length > 1) return null;
    }

    return null;
  }

  function matchAccount(accountName: string | undefined): ImportAccountMatchResult<T> {
    const raw = String(accountName ?? "").trim();
    if (!raw) return result(null, [], { targetKind: null, targetBankNames: [] });

    const targetKind = inferAccountKind(raw);
    const targetBankNames = inferBankNames(raw);
    const targetBankKeys = targetBankNames.map(normalizeImportAccountMatchKey);
    const targetOwnerKeys = inferTargetOwnerKeys(raw);

    const directAccountId = parseImportAccountId(raw);
    if (directAccountId) {
      return result(indexed.find((item) => item.account.id === directAccountId)?.account ?? null, [], { targetKind, targetBankNames });
    }

    const targetKeys = buildImportAccountInputCandidates(raw).map(normalizeImportAccountMatchKey).filter(Boolean);
    if (targetKeys.length === 0) return result(null, [], { targetKind, targetBankNames });
    /** 用户输入的原文（归一化），用于「账户名与输入完全一致」的优先判断。 */
    const inputKey = normalizeImportAccountMatchKey(raw);

    const last4 = extractImportAccountLast4(raw);

    for (const targetKey of targetKeys) {
      const exactMatches = indexed.filter((item) => item.keys.includes(targetKey));
      const compatibleExactMatches = exactMatches.filter((item) => hasCompatibleLast4(item, last4));
      if (compatibleExactMatches.length > 0) {
        // 「账户名就是用户输入的文本」优先于「只有机构名/别名撞上」。
        // 例子：账本里有「招商银行」(借记卡) 和「招商银行·朝朝宝」(投资)，
        // 输入「招商银行」时只有前者是账户名，不该因为它同时也命中了
        // 后者的机构别名就变成二选一。
        let sameName = compatibleExactMatches.filter(
          (item) => normalizeImportAccountMatchKey(item.account.name) === inputKey,
        );
        if (sameName.length > 1) {
          const ownerFilterKeys = targetOwnerKeys.length > 0
            ? targetOwnerKeys
            : contextOwnerKey
              ? [contextOwnerKey]
              : [];
          if (ownerFilterKeys.length > 0) {
            const sameOwner = sameName.filter((item) =>
              ownerFilterKeys.some((ownerKey) => item.ownerKeys.includes(ownerKey)),
            );
            if (sameOwner.length > 0) sameName = sameOwner;
          }
        }
        if (sameName.length === 1) {
          return result(sameName[0].account, [], { targetKind, targetBankNames });
        }
        const narrowed = pickUnique(compatibleExactMatches, { last4, targetKind, targetBankKeys, targetOwnerKeys });
        if (narrowed) return result(narrowed, [], { targetKind, targetBankNames });
        if (
          compatibleExactMatches.length === 1 &&
          (!targetKind || !compatibleExactMatches[0].account.kind || compatibleExactMatches[0].account.kind === targetKind) &&
          // The single exact hit must still respect an explicit owner prefix:
          // "张四的招商银行信用卡" expands to a bare "招商银行信用卡" key which can
          // exact-match a differently-owned "信用卡" account; that hit must fall
          // through to owner-aware stages instead of returning here.
          ownerKeyMatches(compatibleExactMatches[0], targetOwnerKeys)
        ) {
          return result(compatibleExactMatches[0].account, [], { targetKind, targetBankNames });
        }
        if (!targetKind && compatibleExactMatches.length > 1 && isImportUnionPayDebitTailSourceHint(raw)) {
          const paymentSource = pickUnionPayDebitSource(compatibleExactMatches);
          if (paymentSource) return result(paymentSource, [], { targetKind, targetBankNames });
        }
        if (!targetKind && compatibleExactMatches.length > 1 && isBareLast4Hint(raw)) {
          const paymentSource = pickPaymentTailSource(compatibleExactMatches);
          if (paymentSource) return result(paymentSource, [], { targetKind, targetBankNames });
        }
        if (!targetKind && compatibleExactMatches.length > 1) {
          return result(null, compatibleExactMatches, { targetKind, targetBankNames });
        }
      }
    }

    // "XX的往来款" pattern: try to match extracted counterparty name directly
    // against loan account names, bypassing kind-alias partial matching.
    if (targetKind === "settlement") {
      const counterpartyName = parseSettlementAccountName(raw);
      if (counterpartyName) {
        const cKey = normalizeImportAccountMatchKey(counterpartyName);
        if (cKey) {
          const loanMatches = indexed.filter(
            (item) => (item.account.kind === "settlement" || item.account.kind === "loan") && item.keys.includes(cKey),
          );
          if (loanMatches.length === 1) {
            return result(loanMatches[0].account, [], { targetKind, targetBankNames });
          }
        }
      }
    }

    if (last4) {
      const byLast4 = indexed.filter((item) => {
        if (item.last4 !== last4) return false;
        if (targetKind && item.account.kind && targetKind !== item.account.kind) return false;
        if (!ownerKeyMatches(item, targetOwnerKeys)) return false;
        return bankKeyMatches(item, targetBankKeys);
      });
      if (byLast4.length === 1) return result(byLast4[0].account, [], { targetKind, targetBankNames });
      if (byLast4.length > 1 && isImportUnionPayDebitTailSourceHint(raw)) {
        const paymentSource = pickUnionPayDebitSource(byLast4);
        if (paymentSource) return result(paymentSource, [], { targetKind, targetBankNames });
      }
      if (byLast4.length > 1 && isImportPaymentTailSourceHint(raw)) {
        const paymentSource = pickPaymentTailSource(byLast4);
        if (paymentSource) return result(paymentSource, [], { targetKind, targetBankNames });
      }
      if (byLast4.length > 1 && !targetKind && isBareLast4Hint(raw)) {
        const paymentSource = pickPaymentTailSource(byLast4);
        if (paymentSource) return result(paymentSource, [], { targetKind, targetBankNames });
      }
      if (byLast4.length > 1) return result(null, byLast4, { targetKind, targetBankNames });
    }

    const alipayBalanceProduct = pickAlipayBalanceProduct(raw);
    if (alipayBalanceProduct) return result(alipayBalanceProduct, [], { targetKind, targetBankNames });

    const uniqueThirdPartyPaymentProduct = pickUniqueThirdPartyPaymentProduct(raw);
    if (uniqueThirdPartyPaymentProduct) {
      return result(uniqueThirdPartyPaymentProduct, [], { targetKind, targetBankNames });
    }

    if (targetKind && targetBankKeys.length > 0) {
      const byBankAndKind = indexed.filter((item) => {
        if (item.account.kind !== targetKind) return false;
        if (!hasCompatibleLast4(item, last4)) return false;
        if (!ownerKeyMatches(item, targetOwnerKeys)) return false;
        return bankKeyMatches(item, targetBankKeys);
      });
      if (byBankAndKind.length === 1) return result(byBankAndKind[0].account, [], { targetKind, targetBankNames });
      if (byBankAndKind.length > 1) return result(null, byBankAndKind, { targetKind, targetBankNames });
    }

    for (const targetKey of targetKeys) {
      // 纯所有人名两边都不参与"互相包含"匹配：它只能收窄，不能识别账户。
      if (ownerOnlyKeys.has(targetKey)) continue;
      const partialMatches = indexed.filter((item) =>
        item.keys.some((key) =>
          key.length >= 3 &&
          !ownerOnlyKeys.has(key) &&
          (targetKey.includes(key) || key.includes(targetKey)),
        ),
      );

      const compatiblePartialMatches = partialMatches.filter((item) => {
        if (!hasCompatibleLast4(item, last4)) return false;
        if (targetKind && item.account.kind && item.account.kind !== targetKind) return false;
        if (targetBankKeys.length > 0 && !bankKeyMatches(item, targetBankKeys)) return false;
        if (!ownerKeyMatches(item, targetOwnerKeys)) return false;
        return true;
      });
      if (compatiblePartialMatches.length === 1) {
        return result(compatiblePartialMatches[0].account, [], { targetKind, targetBankNames });
      }
      if (compatiblePartialMatches.length > 1) {
        const narrowed = pickUnique(compatiblePartialMatches, { last4, targetKind, targetBankKeys, targetOwnerKeys });
        if (narrowed) return result(narrowed, [], { targetKind, targetBankNames });
        return result(null, compatiblePartialMatches, { targetKind, targetBankNames });
      }
    }

    return result(null, [], { targetKind, targetBankNames });
  }

  return (accountName: string | undefined): ImportAccountMatchResult<T> => {
    const matched = matchAccount(accountName);
    if (matched.account || !contextOwnerKey || matched.ambiguousAccounts.length < 2) return matched;
    // 文本自己写了所有人时以文本为准（它已经在匹配阶段被用作收窄条件）。
    if (inferTargetOwnerKeys(String(accountName ?? "")).length > 0) return matched;
    const sameOwner = matched.ambiguousAccounts.filter((account) =>
      accountOwnerKeys(account).includes(contextOwnerKey),
    );
    if (sameOwner.length === 0) return matched;
    if (sameOwner.length === 1) return { ...matched, account: sameOwner[0], ambiguousAccounts: [] };
    // 同一所有人下仍有多个：只保留这些候选，提示里不再混入别人的账户。
    return { ...matched, ambiguousAccounts: sameOwner };
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

/**
 * 导入解析的最后一道兜底：账户名片段出现在导入文本里（或反过来）。
 *
 * 只认**唯一且具体**的命中：
 * - 跳过「机构名 / 机构+类型」这类泛化键（「支付宝」「支付宝投资账户」）——
 *   它们不包含账户自身的名字，任何以机构名开头的未识别文本都会被第一个
 *   同机构账户吞掉；
 * - 多个账户命中时不猜，留给用户在预览里选。
 *
 * 旧实现是「谁先命中就返回谁」：支付宝账单里的「张四支付宝基金」被同机构
 * 第一个投资账户「理财账户1100」匹配走，交易就记到了错误的账户上。
 */
export function findSoleFallbackImportAccount<T extends ImportAccountMatchSource>(
  accountName: string | undefined,
  accounts: readonly T[],
): T | null {
  const targetKey = normalizeImportAccountMatchKey(accountName);
  if (targetKey.length < 3) return null;

  const hits = new Map<string, T>();
  for (const account of accounts) {
    const specificKeys = [account.name, ...(account.AccountAlias?.map((alias) => alias.alias) ?? [])]
      .map((value) => normalizeImportAccountMatchKey(value))
      .filter((key) => key.length >= 3);
    if (specificKeys.length === 0) continue;
    // 候选键必须由账户自身的名字/别名派生（含它），纯机构键「支付宝」不算：
    // 否则「张四支付宝基金」会被「墨支付宝基金」的机构前缀撞上。
    const isSpecificKey = (key: string) => specificKeys.some((specific) => key.includes(specific));
    const matched = buildImportAccountCandidates(account)
      .map((candidate) => normalizeImportAccountMatchKey(candidate))
      .filter((key) => key.length >= 3 && isSpecificKey(key))
      .some((key) => targetKey.includes(key) || key.includes(targetKey));
    if (matched) hits.set(account.id, account);
  }

  return hits.size === 1 ? Array.from(hits.values())[0] : null;
}

function inferAccountKind(value: string): ImportAccountKind | null {
  const key = normalizeImportAccountMatchKey(value);
  for (const item of ACCOUNT_KIND_ALIASES) {
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

function stripAccountKindSeparatorWords(value: string) {
  const names = new Set<string>();
  for (const word of ACCOUNT_KIND_SEPARATOR_WORDS) {
    const normalizedWord = normalizeImportAccountMatchKey(word);
    const key = normalizeImportAccountMatchKey(value);
    if (!normalizedWord || !key.includes(normalizedWord)) continue;
    const next = value.replaceAll(word, "").trim();
    if (next) names.add(next);
  }
  return Array.from(names);
}

function expandImportAccountName(value: string) {
  const trimmed = value.trim();
  const withoutScheduleSuffix = stripImportAccountScheduleSuffix(trimmed);
  const names = new Set<string>([trimmed]);
  if (withoutScheduleSuffix && withoutScheduleSuffix !== trimmed) names.add(withoutScheduleSuffix);
  const last4 = extractImportAccountLast4(value);
  const kinds = new Set<string>();
  const banks = inferBankNames(value);
  const kind = inferAccountKind(value);
  if (kind === "bank_credit") kinds.add("信用卡");
  if (kind === "bank_debit") {
    kinds.add("储蓄卡");
    kinds.add("借记卡");
  }
  if (kind === "ewallet") {
    kinds.add("电子钱包");
    kinds.add("钱包");
  }
  if (kind === "cash") kinds.add("现金");
  if (kind === "investment") kinds.add("投资账户");
  if (kind === "loan" || kind === "settlement") {}

  for (const kindName of kinds) {
    const normalizedKindName = normalizeImportAccountMatchKey(kindName);
    const withoutKind = Array.from(names)
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => ({ name, key: normalizeImportAccountMatchKey(name) }))
      .filter((item) => item.key.endsWith(normalizedKindName))
      .map((item) => item.name.slice(0, Math.max(0, item.name.length - kindName.length)).trim());
    for (const name of withoutKind) {
      if (name) names.add(name);
    }
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

  for (const name of [...names]) {
    for (const stripped of stripAccountKindSeparatorWords(name)) names.add(stripped);
  }

  return Array.from(names).filter(Boolean);
}
