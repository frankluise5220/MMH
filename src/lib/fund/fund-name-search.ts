// 联网补代码：本地基金库里没有的基金，用天天基金的名称搜索接口反查 6 位代码。
//
// 搜索结果不能直接信 —— 同一个基金 often 有多个份额，名称只差几个字却是两只
// 不同基金：「嘉实美国成长股票人民币」和「嘉实美国成长股票美元现汇」是两个代码，
// 「...混合A」和「...混合C」也是。所以选候选时要三重校验：
//   1. 份额后缀（末位字母）必须一致；
//   2. 币种标记（人民币 / 美元现汇 / 美元现钞）必须一致，缺省按人民币；
//   3. 剩下的名字算字符二元组相似度，远高于其它候选才敢自动填上。
// 拿不准就返回 null，让用户在预览里手填一次 —— 填错份额比留空更糟糕。

export type FundSearchCandidate = { fundCode: string; name: string };

const SEARCH_ENDPOINT = "https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx";

const headers = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  Referer: "https://fund.eastmoney.com/",
};

function normalizeName(value: string) {
  return String(value ?? "")
    .replace(/\s+/g, "")
    .replace(/[\uff08(]/g, "(")
    .replace(/[\uff09)]/g, ")")
    .toUpperCase();
}

/**
 * 搜索时把份额后缀扔掉能提高召回：「...混合A」搜不到「...混合A发起式」，
 * 但搜「...混合」能同时召回 A / C 两份，再靠后缀筛。
 */
function stripShareSuffix(name: string) {
  return name.replace(/[A-Z]$/, "");
}

/** 币种区分份额：美元现汇 / 美元现钞 / 人民币，缺省算人民币。 */
function currencyTag(name: string) {
  const key = normalizeName(name);
  if (key.includes("\u7f8e\u5143\u73b0\u6c47")) return "USD-SETTLE";
  if (key.includes("\u7f8e\u5143\u73b0\u949e")) return "USD-CASH";
  if (key.includes("\u7f8e\u5143")) return "USD";
  if (key.includes("\u6b27\u5143")) return "EUR";
  if (key.includes("\u6e2f\u5e01")) return "HKD";
  return "CNY";
}

const CURRENCY_TOKENS = [
  "\u7f8e\u5143\u73b0\u6c47",
  "\u7f8e\u5143\u73b0\u949e",
  "\u7f8e\u5143",
  "\u6b27\u5143",
  "\u6e2f\u5e01",
  "\u4eba\u6c11\u5e01",
];

function stripCurrencyTokens(normalized: string) {
  return CURRENCY_TOKENS.reduce((acc, token) => acc.split(token).join(""), normalized);
}

/**
 * 份额后缀要先把币种尾巴剥掉再取末位字母 ——
 * 「…指数(QDII)C人民币」的 C 不在末尾，直接取末位会漏掉这一类。
 */
function shareSuffix(name: string) {
  return stripCurrencyTokens(normalizeName(name)).match(/[A-Z]$/)?.[0] ?? "";
}

/** 去掉币种尾巴与份额后缀后的「裸名」，用于比较是不是同一只基金。 */
function bareName(name: string) {
  return stripShareSuffix(stripCurrencyTokens(normalizeName(name)));
}

function bigrams(value: string) {
  const set = new Set<string>();
  for (let index = 0; index + 2 <= value.length; index += 1) set.add(value.slice(index, index + 2));
  return set;
}

function similarity(a: string, b: string) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const left = bigrams(a);
  const right = bigrams(b);
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/**
 * 最长公共子序列占比。基金全名经常只是「多了几个字」的差异
 * （华商元亨灵活配置混合A vs 华商元亨混合A），二元组相似度对这种插入不敏感，
 * LCS 才认得出来。
 */
function lcsRatio(a: string, b: string) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const rows = a.length;
  const cols = b.length;
  let previous = new Array<number>(cols + 1).fill(0);
  let current = new Array<number>(cols + 1).fill(0);
  for (let i = 1; i <= rows; i += 1) {
    for (let j = 1; j <= cols; j += 1) {
      current[j] = a[i - 1] === b[j - 1]
        ? previous[j - 1] + 1
        : Math.max(previous[j], current[j - 1]);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  // Dice 系数：用 min(len) 归一化会让任何短名只要是其子序列就得到 1.0，
  // 于是「淳厚信睿…」和「淳厚信泽…」并列、被"太接近"规则一起否掉。
  // 2*LCS/(|a|+|b|) 才会真正对多出来的字扣分。
  return (2 * previous[cols]) / (rows + cols);
}

function nameScore(a: string, b: string) {
  return Math.max(similarity(a, b), lcsRatio(a, b));
}

/**
 * 括号外的主体名：账单写「...混合A(QDII)」，库里可能是「...混合A人民币」，
 * 括号里这两种差异不代表换了一只基金，主体才决定。
 */
function subjectName(name: string) {
  return normalizeName(name).replace(/\([^)]*\)/g, "");
}

/** 基金公司前缀（前两个字）作为额外的安全约束：不同公司不会误配到同一只。 */
function companyPrefix(name: string) {
  return subjectName(name).slice(0, 2);
}

/**
 * 从搜索候选里挑和账单基金名最可能是同一只的那条。
 * 三重约束：份额后缀一致、币种一致、基金公司前缀一致，再看名字相似度。
 * 只有明显压过其它候选时才返回结果。
 */
export function pickFundSearchCandidate(
  billName: string,
  candidates: readonly FundSearchCandidate[],
): FundSearchCandidate | null {
  const billNormalized = normalizeName(billName);
  if (!billNormalized) return null;
  const billSuffix = shareSuffix(billName);
  const billCurrency = currencyTag(billName);
  const billCompany = companyPrefix(billName);

  const scored = candidates
    .map((candidate) => ({ ...candidate, key: normalizeName(candidate.name) }))
    .filter((candidate) => /^\d{6}$/.test(candidate.fundCode.trim()))
    .filter((candidate) => (candidate.key.match(/[A-Z]$/)?.[0] ?? "") === billSuffix)
    .filter((candidate) => currencyTag(candidate.name) === billCurrency)
    .filter((candidate) => companyPrefix(candidate.name) === billCompany)
    .map((candidate) => ({
      fundCode: candidate.fundCode.trim(),
      name: candidate.name,
      score: nameScore(bareName(billName), bareName(candidate.name)),
    }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const runnerUp = scored[1];
  if (!best || best.score < 0.6) return null;
  // 和次优候选太接近说明真的分不清，交给用户。
  if (runnerUp && best.score - runnerUp.score < 0.08) return null;
  return { fundCode: best.fundCode, name: best.name };
}

/** 天天基金的名称搜索：返回代码 + 名称候选。 */
export async function searchFundByName(keyword: string, signal?: AbortSignal): Promise<FundSearchCandidate[]> {
  const query = String(keyword ?? "").trim();
  if (!query) return [];
  const url = `${SEARCH_ENDPOINT}?m=1&key=${encodeURIComponent(stripShareSuffix(query))}`;
  try {
    const response = await fetch(url, { headers, cache: "no-store", signal });
    if (!response.ok) return [];
    const text = await response.text();
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
      const matched = text.match(/\{.+\}/);
      if (matched) data = JSON.parse(matched[0]);
    }
    const rows: any[] = Array.isArray(data?.Datas) ? data.Datas : [];
    return rows
      .map((row) => ({ fundCode: String(row?.CODE ?? row?._id ?? "").trim(), name: String(row?.NAME ?? "").trim() }))
      .filter((row) => /^\d{6}$/.test(row.fundCode) && row.name);
  } catch {
    return [];
  }
}

/**
 * 联网把基金名换成代码。命中时会连同 Search 到的规范名称一起返回，
 * 调用方可据此把基金资料写进本地库，下次就走本地匹配、不用再联网。
 */
export async function resolveFundCodeBySearch(
  billName: string,
  signal?: AbortSignal,
): Promise<FundSearchCandidate | null> {
  const candidates = await searchFundByName(billName, signal);
  if (candidates.length === 0) return null;
  return pickFundSearchCandidate(billName, candidates);
}
