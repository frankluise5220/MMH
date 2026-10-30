// 基金「名称 → 6 位代码」的反查。
//
// 支付宝 / 微信账单只有基金名称（如「摩根标普500指数(QDII)A」），没有基金代码，
// 而基金导入后端要求代码必须是 /^\d{6}$/。所以要把账单里的名字对上本地已有的
// FundProfile / FundNavCache 记录，拿到真实代码。
//
// 难点是份额后缀：`...混合A` 和 `...混合C` 是两只不同基金，代码也不同 ——
// 匹配必须要求份额后缀一致，宁可查不到让用户手填一次，也不能串基金。

export type FundNameLibraryEntry = { fundCode: string; name: string };

export type FundNameMatchResult = {
  name: string;
  fundCode: string;
  matchedName: string;
  /** true = 名称完全对上；false = 份额后缀一致的核心名匹配（ harmed alias） */
  exact: boolean;
};

function normalizeFundName(value: string) {
  return String(value ?? "")
    .replace(/\s+/g, "")
    .replace(/[\uff08(]/g, "(")
    .replace(/[\uff09)]/g, ")")
    .toUpperCase();
}

/**
 * 拆出「核心名 + 份额后缀」。账单和本地库的命名习惯不同
 * （「华商元亨灵活配置混合A」 vs 「华商元亨混合A」），但份额后缀必须一致。
 */
export function splitFundShareClass(name: string) {
  const normalized = normalizeFundName(name);
  const matched = normalized.match(/^(.*?)([A-Z])$/);
  if (!matched) return { core: normalized, suffix: "" };
  return { core: matched[1] ?? normalized, suffix: matched[2] ?? "" };
}

/**
 * 用账单里的基金名去本地库里找代码。返回能确定的匹配；不确定的不返回，
 * 由调用方留空让用户手写 —— 宁可少填，也不能对错基金。
 */
export function matchFundNameToCode(
  billName: string,
  library: readonly FundNameLibraryEntry[],
): FundNameMatchResult | null {
  const target = normalizeFundName(billName);
  if (!target) return null;

  const bill = splitFundShareClass(billName);
  const candidates = library
    .map((entry) => ({ ...entry, key: normalizeFundName(entry.name), ...splitFundShareClass(entry.name) }))
    .filter((entry) => entry.key);

  const exact = candidates.find((entry) => entry.key === target);
  if (exact) {
    return { name: billName, fundCode: exact.fundCode, matchedName: exact.name, exact: true };
  }

  // 份额后缀必须一致；核心名取互相包含中更短的那个当作同一个基金的写法差异。
  const shareMatched = candidates.filter((entry) => entry.suffix === bill.suffix
    && (entry.core === bill.core || entry.core.includes(bill.core) || bill.core.includes(entry.core)));
  const unique = new Map(shareMatched.map((entry) => [entry.fundCode, entry]));
  if (unique.size === 1) {
    const [hit] = Array.from(unique.values());
    return { name: billName, fundCode: hit.fundCode, matchedName: hit.name, exact: false };
  }
  return null;
}

export function matchFundNamesToCodes(
  billNames: readonly string[],
  library: readonly FundNameLibraryEntry[],
): { resolved: FundNameMatchResult[]; unresolved: string[] } {
  const resolved: FundNameMatchResult[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  for (const name of billNames) {
    const key = normalizeFundName(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const hit = matchFundNameToCode(name, library);
    if (hit) resolved.push(hit);
    else unresolved.push(name);
  }
  return { resolved, unresolved };
}
