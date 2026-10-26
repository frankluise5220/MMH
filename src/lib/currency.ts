type AccountCurrencyLike = {
  readonly name?: string | null;
  readonly currency?: string | null;
};

export const CURRENCY_OPTIONS = [
  { value: "CNY" },
  { value: "USD" },
  { value: "JPY" },
  { value: "EUR" },
  { value: "HKD" },
  { value: "GBP" },
  { value: "KRW" },
  { value: "SGD" },
  { value: "TWD" },
  { value: "AUD" },
  { value: "CAD" },
  { value: "CHF" },
  { value: "THB" },
  { value: "MYR" },
  { value: "VND" },
  { value: "INR" },
  { value: "PHP" },
  { value: "IDR" },
  { value: "MOP" },
] as const;


/**
 * Country (Chinese) → ISO currency code mapping.
 * Used to auto-suggest a currency code when the user fills in the country field.
 * Extend this map as needed; it's a fallback / hint, not authoritative.
 */
export const COUNTRY_TO_CURRENCY: Record<string, string> = {
  // Asia
  中国: "CNY",
  中国大陆: "CNY",
  大陆: "CNY",
  香港: "HKD",
  中国香港: "HKD",
  澳门: "MOP",
  中国澳门: "MOP",
  台湾: "TWD",
  中国台湾: "TWD",
  日本: "JPY",
  韩国: "KRW",
  南韩: "KRW",
  朝鲜: "KPW",
  新加坡: "SGD",
  马来西亚: "MYR",
  泰国: "THB",
  越南: "VND",
  印度: "INR",
  菲律宾: "PHP",
  印尼: "IDR",
  印度尼西亚: "IDR",
  土耳其: "TRY",
  以色列: "ILS",
  哈萨克斯坦: "KZT",
  // Europe
  欧盟: "EUR",
  欧元区: "EUR",
  德国: "EUR",
  法国: "EUR",
  意大利: "EUR",
  西班牙: "EUR",
  荷兰: "EUR",
  比利时: "EUR",
  奥地利: "EUR",
  葡萄牙: "EUR",
  希腊: "EUR",
  英国: "GBP",
  瑞士: "CHF",
  瑞典: "SEK",
  挪威: "NOK",
  丹麦: "DKK",
  波兰: "PLN",
  捷克: "CZK",
  匈牙利: "HUF",
  罗马尼亚: "RON",
  俄罗斯: "RUB",
  乌克兰: "UAH",
  // Americas
  美国: "USD",
  加拿大: "CAD",
  墨西哥: "MXN",
  巴西: "BRL",
  阿根廷: "ARS",
  智利: "CLP",
  哥伦比亚: "COP",
  秘鲁: "PEN",
  // Oceania
  澳大利亚: "AUD",
  新西兰: "NZD",
  // Middle East / Africa
  沙特阿拉伯: "SAR",
  阿联酋: "AED",
  卡塔尔: "QAR",
  科威特: "KWD",
  巴林: "BHD",
  阿曼: "OMR",
  南非: "ZAR",
  埃及: "EGP",
  尼日利亚: "NGN",
  肯尼亚: "KES",
  澳大利亚元: "AUD",
};

export function normalizeCurrency(value: unknown) {
  const text = String(value ?? "CNY").trim().toUpperCase();
  return text || "CNY";
}

export function normalizeOptionalCurrency(value: unknown) {
  if (value == null) return null;
  const text = String(value).trim().toUpperCase();
  return text || null;
}

/**
 * 币种的本地化名。只用于两件事：
 * 1. 识别「账户名里已经写了币种」，避免在 `原名 · USD` 末尾再拼一次 `· USD`；
 * 2. 兜底展示。
 * **入库的账户名一律用 ISO 代码**（`张四的现金 · USD`），不能把「美元」写进
 * `Account.name`，否则切到英文界面这个名字永远不会变。
 */
const CURRENCY_LOCAL_NAMES: Record<string, { zh: string; en: string }> = {
  CNY: { zh: "人民币", en: "Chinese yuan" },
  USD: { zh: "美元", en: "US dollar" },
  JPY: { zh: "日元", en: "Japanese yen" },
  EUR: { zh: "欧元", en: "Euro" },
  HKD: { zh: "港币", en: "Hong Kong dollar" },
  GBP: { zh: "英镑", en: "Pound sterling" },
  KRW: { zh: "韩元", en: "Korean won" },
  SGD: { zh: "新加坡元", en: "Singapore dollar" },
  TWD: { zh: "新台币", en: "New Taiwan dollar" },
  AUD: { zh: "澳元", en: "Australian dollar" },
  CAD: { zh: "加元", en: "Canadian dollar" },
  CHF: { zh: "瑞士法郎", en: "Swiss franc" },
  THB: { zh: "泰铢", en: "Thai baht" },
  MYR: { zh: "林吉特", en: "Malaysian ringgit" },
  MOP: { zh: "澳门元", en: "Macanese pataca" },
};

/**
 * 账户标签里的币种文本：**只有非本位币才显示**（2026-10-18 用户裁定）。
 * 调用方没有传本位币时返回空串 —— 绝不拿 `"CNY"` 猜，否则本位币是 USD 的
 * 账簿会给每个人民币账户平白加一个 `· CNY`。
 */
export function accountCurrencyLabelText(
  currency: string | null | undefined,
  baseCurrency: string | null | undefined,
): string {
  if (!currency || !baseCurrency) return "";
  const code = normalizeCurrency(currency);
  return code === normalizeCurrency(baseCurrency) ? "" : code;
}

/**
 * 账户名里是否已经写了这个币种（ISO 代码按词边界，中文名按包含）。
 * 子账户默认名就是「原名 · USD」，不去重会渲染成「… · USD · USD」。
 */
export function accountNameMentionsCurrency(accountName: string | null | undefined, currency: string): boolean {
  const name = String(accountName ?? "").trim();
  if (!name) return false;
  const code = normalizeCurrency(currency);
  const lowerName = name.toLocaleLowerCase();
  const candidates = [code, CURRENCY_LOCAL_NAMES[code]?.zh ?? ""].filter(Boolean);
  return candidates.some((candidate) => {
    const lower = candidate.toLocaleLowerCase();
    if (!lower) return false;
    if (/^[A-Z]{3}$/i.test(candidate)) {
      const index = lowerName.indexOf(lower);
      if (index < 0) return false;
      const before = lowerName[index - 1] ?? "";
      const after = lowerName[index + lower.length] ?? "";
      return !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after);
    }
    return lowerName.includes(lower);
  });
}

export function resolveSameCurrencyTransfer(fromAccount: AccountCurrencyLike, toAccount: AccountCurrencyLike) {
  const fromCurrency = normalizeCurrency(fromAccount.currency);
  const toCurrency = normalizeCurrency(toAccount.currency);
  if (fromCurrency !== toCurrency) {
    const fromName = fromAccount.name?.trim() || "source account";
    const toName = toAccount.name?.trim() || "target account";
    throw new Error(
      `Standard transfers only support accounts with the same currency. ${fromName} is ${fromCurrency}, ${toName} is ${toCurrency}; use the currency exchange or cross-currency transfer flow for different currencies.`
    );
  }
  return fromCurrency;
}
