/**
 * 基金净值查询统一入口
 *
 * 两种调用模式：
 * 1. 查询最新净值：不传 dateStr → 按优先级尝试所有 API，返回最新可用净值
 * 2. 查询指定日期净值：传入 dateStr → 只使用支持日期过滤的 API（baseUrl 含 {date} 占位符），
 *    跳过不支持日期过滤的 API（如 eastmoney 实时估值），避免返回错误日期的净值
 *
 * @param fundCode 基金代码
 * @param dateStr 净值日期（YYYY-MM-DD），不传则查询最新
 * @param accountId 资金账户ID（可选，用于账户级默认 API）
 * @returns 净值信息或 null
 */
import { prisma } from "@/lib/db/prisma";

type NavResult = {
  nav: number;
  cumNav?: number;
  name?: string;
  date: string;
} | null;

export type FundIdentityResult = {
  code: string;
  name: string;
  fullName?: string;
  source: string;
} | null;

const headers = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  Referer: "http://fundf10.eastmoney.com/",
};

async function fetchFromUrl(url: string, parser: (data: any) => NavResult): Promise<NavResult> {
  try {
    const res = await fetch(url, { headers, cache: "no-store" });
    if (!res.ok) return null;
    const text = await res.text();
    let data: any;
    try { data = JSON.parse(text); } catch {
      // 天天基金返回的是 JS 格式
      const m = text.match(/\{.+\}/);
      if (!m) return null;
      try { data = JSON.parse(m[0]); } catch { return null; }
    }
    return parser(data);
  } catch {
    return null;
  }
}

// eastmoney parser — 最新净值 (天天基金)
function parseEastmoney(data: any): NavResult {
  if (!data?.dwjz) return null;
  return {
    date: data.jzrq as string,
    nav: parseFloat(data.dwjz),
    cumNav: parseFloat(data.dwjz),
    name: data.name as string,
  };
}

/**
 * eastmoney_history parser — 历史净值 (东方财富)
 * 支持解析多条记录，用于查找最接近目标日期的净值
 */
function parseEastmoneyHistoryList(data: any): { FSRQ: string; DWJZ: string; LJJZ: string }[] {
  return data?.Data?.LSJZList ?? [];
}

function parseEastmoneyHistory(data: any): NavResult {
  const list = parseEastmoneyHistoryList(data);
  if (list.length > 0) {
    return {
      date: list[0]!.FSRQ,
      nav: parseFloat(list[0]!.DWJZ),
      cumNav: parseFloat(list[0]!.LJJZ),
    };
  }
  return null;
}

// danjuan parser — 蛋卷基金
function parseDanjuan(data: any): NavResult {
  if (!data?.data?.nav) return null;
  return {
    date: data.data.nav_date || "",
    nav: parseFloat(data.data.nav),
    cumNav: data.data.cum_nav ? parseFloat(data.data.cum_nav) : undefined,
    name: data.data.fund_name,
  };
}

function normalizeFundName(name: unknown): string | null {
  const value = String(name ?? "").trim();
  if (!value || value.length < 2) return null;
  if (/基金历史净值|基金档案|天天基金|基金吧|搜索结果/.test(value)) return null;
  return value;
}

export async function queryFundIdentity(fundCode: string): Promise<FundIdentityResult> {
  const code = fundCode.trim();
  if (!/^\d{6}$/.test(code)) return null;

  try {
    const url = `http://fundf10.eastmoney.com/jjjz_${code}.html`;
    const res = await fetch(url, {
      headers: { ...headers, Referer: url },
      cache: "no-store",
    });
    if (res.ok) {
      const html = await res.text();
      const patterns = [
        /<title[^>]*>\s*([^<]*?)\s*[（(]\s*(\d{6})\s*[）)]/i,
        /<meta\s+name=["']keywords["']\s+content=["']([^,"']+),\s*(\d{6})[,"]/i,
        /<meta\s+name=["']description["']\s+content=["'][^"']*?提供([^("']+)[（(](\d{6})[）)]/i,
      ];
      for (const pattern of patterns) {
        const match = html.match(pattern);
        if (!match || match[2] !== code) continue;
        const name = normalizeFundName(match[1]);
        if (name) return { code, name, source: "eastmoney-f10" };
      }
    }
  } catch {
    // Try the next source.
  }

  try {
    const url = `https://danjuanfunds.com/djapi/fund/${code}`;
    const res = await fetch(url, {
      headers: {
        ...headers,
        Referer: `https://danjuanfunds.com/fund/${code}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });
    if (res.ok) {
      const data: any = await res.json();
      const fdCode = String(data?.data?.fd_code ?? data?.fd_code ?? "").trim();
      if (fdCode === code) {
        const name = normalizeFundName(data?.data?.fd_name ?? data?.fd_name);
        if (name) {
          const fullName = normalizeFundName(data?.data?.fd_full_name ?? data?.fd_full_name) ?? undefined;
          return { code, name, fullName, source: "danjuan" };
        }
      }
    }
  } catch {
    // No identity result.
  }

  return null;
}

const PARSERS: Record<string, (data: any) => NavResult> = {
  eastmoney: parseEastmoney,
  eastmoney_history: parseEastmoneyHistory,
  danjuan: parseDanjuan,
  // sina and alipay fall through to generic parsers
};

/**
 * 获取所有活跃的查询 API（按优先级排序）
 */
async function getActiveApis() {
  return prisma.fundQueryApi.findMany({
    where: { isActive: true },
    orderBy: { priority: "asc" },
  });
}

/**
 * 查询历史净值（扩大日期范围）
 * 当精确日期查询失败时，尝试查询前后几天的净值，返回最接近目标日期的净值
 *
 * @param fundCode 基金代码
 * @param targetDate 目标日期（YYYY-MM-DD）
 * @param rangeDays 查询范围天数（向前扩展几天），默认 90 天（覆盖一个季度）
 * @returns 净值信息（包含实际净值日期）或 null
 */
export async function queryHistoricalNav(
  fundCode: string,
  targetDate: string,
  rangeDays: number = 90
): Promise<NavResult> {
  // 计算查询范围：目标日期前 rangeDays 天到目标日期
  const target = new Date(targetDate + "T00:00:00Z");
  const startDate = new Date(target.getTime() - rangeDays * 24 * 60 * 60 * 1000);
  const endDate = target;

  const startStr = startDate.toISOString().slice(0, 10);
  const endStr = endDate.toISOString().slice(0, 10);

  // 查询 eastmoney_history API（扩大日期范围）
  const url = `http://api.fund.eastmoney.com/f10/lsjz?fundCode=${fundCode}&pageIndex=1&pageSize=50&startDate=${startStr}&endDate=${endStr}`;

  try {
    const res = await fetch(url, { headers, cache: "no-store" });
    if (!res.ok) return null;
    const text = await res.text();
    let data: any;
    try { data = JSON.parse(text); } catch { return null; }

    const list = parseEastmoneyHistoryList(data);
    if (list.length === 0) return null;

    // 按日期降序排列（最新的在前）
    const sortedList = list.sort((a, b) => new Date(b.FSRQ).getTime() - new Date(a.FSRQ).getTime());

    // 找到目标日期或之前最近的净值（确认日期不应该晚于目标日期）
    const targetTime = target.getTime();
    for (const item of sortedList) {
      const itemDate = new Date(item.FSRQ + "T00:00:00Z");
      // 选择目标日期或之前最近的交易日净值
      if (itemDate.getTime() <= targetTime) {
        return {
          date: item.FSRQ,
          nav: parseFloat(item.DWJZ),
          cumNav: parseFloat(item.LJJZ),
        };
      }
    }

    // 如果目标日期之前没有净值，返回列表中最接近的（最新的）
    const closest = sortedList[0];
    if (closest) {
      return {
        date: closest.FSRQ,
        nav: parseFloat(closest.DWJZ),
        cumNav: parseFloat(closest.LJJZ),
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * 统一查询基金净值
 * 优先使用账户配置的默认 API，未配置则按优先级尝试所有活跃 API
 */
export async function queryFundNav(
  fundCode: string,
  dateStr?: string,
  accountId?: string,
): Promise<NavResult> {
  // 获取活跃 API 列表
  const activeApis = await getActiveApis();
  if (activeApis.length === 0) return null;

  // 如果指定了账户，尝试用该账户的默认 API
  let orderedApis = activeApis;
  if (accountId) {
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: { defaultFundQueryApiId: true },
    });
    if (account?.defaultFundQueryApiId) {
      const defaultApi = activeApis.find(a => a.id === account!.defaultFundQueryApiId);
      if (defaultApi) {
        // 将默认 API 移到最前面
        orderedApis = [defaultApi, ...activeApis.filter(a => a.id !== defaultApi.id)];
      }
    }
  }

  // 按优先级尝试每个 API
  for (const api of orderedApis) {
    const parser = PARSERS[api.code];
    if (!parser) continue;

    // 指定日期查询时，跳过不支持日期过滤的 API（baseUrl 不含 {date} 占位符）
    if (dateStr && !api.baseUrl.includes("{date}")) continue;

    let url = api.baseUrl;
    url = url.replaceAll("{code}", fundCode);
    if (dateStr) url = url.replaceAll("{date}", dateStr);

    const result = await fetchFromUrl(url, parser);
    if (result) return result;
  }

  // 精确日期查询失败，尝试扩大范围查询历史净值
  if (dateStr) {
    const historicalResult = await queryHistoricalNav(fundCode, dateStr);
    if (historicalResult) return historicalResult;
  }

  return null;
}
