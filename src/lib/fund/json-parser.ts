/**
 * 自定义 JSON 净值源的解析器。
 *
 * 内置的四个解析器写死在代码里（天天基金是 JS 片段、东方财富是 `Data.LSJZList`、
 * 蛋卷和支付宝各有自己的字段名），换一家 API 就得改代码。这里把「怎么从返回报文里
 * 取出净值」变成数据：用户在设置页填几条字段路径，`parser = "json"` 的源就按这份
 * 配置解析，不需要为每一家新增一个 parser。
 *
 * 刻意不支持 JS 表达式：那份配置最终在服务端执行，允许表达式等于把 RCE 交给任何
 * 能改设置的人。只实现 `a.b[0].c` 这种取值用得到的路径子集。
 *
 * 支持的源被限定为「GET + 返回 JSON + 静态 key」这一族。需要签名、需要 POST、
 * 返回 HTML 的源仍然只能写代码加内置解析器。
 */

/** key 放在请求头、URL 参数，还是这个源根本不需要鉴权。 */
export type FundJsonAuthIn = "none" | "header" | "query";

/**
 * 按日期取净值的能力：
 * - `none`   只能取「最新净值」，历史确认日不能交给它；
 * - `param`  地址里有 `{date}` 占位符，按日期直查；
 * - `series` 一次返回一段区间序列，从数组里挑目标日（`series*` 系列字段）。
 */
export type FundJsonDateMode = "none" | "param" | "series";

export type FundJsonParserConfig = {
  authIn: FundJsonAuthIn;
  /** 鉴权参数名，如 `X-api-key`、`key`、`Authorization`。 */
  authName: string;
  /** 鉴权值前缀，如 `Bearer `。 */
  authPrefix: string;
  /** 拼在基金代码后面的后缀，如 `.SZ`（同花顺一类的 thscode 接口要求）。 */
  codeSuffix: string;
  dateMode: FundJsonDateMode;

  /** 单位净值路径（`series` 模式之外必填）。 */
  navPath: string;
  cumNavPath: string;
  datePath: string;
  namePath: string;

  /** `series` 模式：数组所在路径，及其元素内的净值 / 日期路径。 */
  seriesPath: string;
  seriesNavPath: string;
  seriesDatePath: string;
  seriesCumNavPath: string;
};

export type NavParseContext = { targetDate?: string };

export type NavValue = {
  nav: number;
  cumNav?: number;
  date: string;
  name?: string;
};

type PathToken = string | number;

const EMPTY_CONFIG: FundJsonParserConfig = {
  authIn: "none",
  authName: "",
  authPrefix: "",
  codeSuffix: "",
  dateMode: "none",
  navPath: "",
  cumNavPath: "",
  datePath: "",
  namePath: "",
  seriesPath: "",
  seriesNavPath: "nav",
  seriesDatePath: "date",
  seriesCumNavPath: "",
};

function pickString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 把库里的 `parserConfig`（任意来源：设置页表单、备份 JSON、xlsx 里的字符串）
 * 收成一份字段齐全的配置。完全不是对象时返回 `null`，让调用方按「配置无效」处理。
 */
export function normalizeFundJsonParserConfig(raw: unknown): FundJsonParserConfig | null {
  let value = raw;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return { ...EMPTY_CONFIG };
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (value == null) return { ...EMPTY_CONFIG };
  if (typeof value !== "object" || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  const authInRaw = pickString(record.authIn).toLowerCase();
  const authIn: FundJsonAuthIn =
    authInRaw === "header" || authInRaw === "query" ? authInRaw : "none";
  const dateModeRaw = pickString(record.dateMode).toLowerCase();
  const dateMode: FundJsonDateMode =
    dateModeRaw === "param" || dateModeRaw === "series" ? dateModeRaw : "none";

  return {
    authIn,
    authName: pickString(record.authName),
    authPrefix: typeof record.authPrefix === "string" ? record.authPrefix : "",
    codeSuffix: pickString(record.codeSuffix),
    dateMode,
    navPath: pickString(record.navPath),
    cumNavPath: pickString(record.cumNavPath),
    datePath: pickString(record.datePath),
    namePath: pickString(record.namePath),
    seriesPath: pickString(record.seriesPath),
    seriesNavPath: pickString(record.seriesNavPath) || EMPTY_CONFIG.seriesNavPath,
    seriesDatePath: pickString(record.seriesDatePath) || EMPTY_CONFIG.seriesDatePath,
    seriesCumNavPath: pickString(record.seriesCumNavPath),
  };
}

/**
 * 给用户看的配置校验。返回空数组表示这份配置拿去解析不会因为「缺字段」白白失败。
 * 设置页和「测试连接」都调这里，别各写一套判断。
 */
export function validateFundJsonParserConfig(raw: unknown): string[] {
  const config = normalizeFundJsonParserConfig(raw);
  if (!config) return ["解析配置不是合法的 JSON 对象"];

  const errors: string[] = [];
  if (config.authIn !== "none" && !config.authName) {
    errors.push("选择了需要鉴权，但没填鉴权参数名（如 X-api-key）");
  }
  if (config.dateMode === "series") {
    if (!config.seriesPath) errors.push("区间模式缺少数组路径（seriesPath）");
    if (!config.seriesNavPath) errors.push("区间模式缺少净值字段名");
    if (!config.seriesDatePath) errors.push("区间模式缺少日期字段名");
  } else {
    if (!config.navPath) errors.push("缺少单位净值路径（navPath）");
    if (!config.datePath) errors.push("缺少净值日期路径（datePath）；没有日期的净值不能入账");
  }
  return errors;
}

/** `data.list[0].nav` → `["data","list",0,"nav"]`。语法不认识时返回 `null`。 */
function tokenizePath(path: string): PathToken[] | null {
  const source = path.trim();
  if (!source) return null;

  const tokens: PathToken[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === ".") {
      index += 1;
      continue;
    }
    if (char === "[") {
      const end = source.indexOf("]", index);
      if (end < 0) return null;
      const inner = source.slice(index + 1, end).trim().replace(/^['"]|['"]$/g, "");
      if (!inner) return null;
      tokens.push(/^\d+$/.test(inner) ? Number(inner) : inner);
      index = end + 1;
      continue;
    }
    let next = index;
    while (next < source.length && source[next] !== "." && source[next] !== "[") next += 1;
    const name = source.slice(index, next).trim();
    if (!name) return null;
    tokens.push(name);
    index = next;
  }
  return tokens.length > 0 ? tokens : null;
}

/** 按路径取值，取不到返回 `undefined`（不要抛错，解析失败只是这一条源不生效）。 */
export function readJsonPath(data: unknown, path: string): unknown {
  const tokens = tokenizePath(path);
  if (!tokens) return undefined;

  let current: unknown = data;
  for (const token of tokens) {
    if (current == null) return undefined;
    if (typeof token === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[token];
      continue;
    }
    if (typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

/** 带千分位、百分号的数值文本统一收成数字；非正数一律视为没取到。 */
export function parseNavNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }
  const raw = String(value ?? "").replace(/,/g, "").trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * 净值日期统一成 `YYYY-MM-DD`。
 * 除 `2026-11-17` / `20261117` / `2026/11/17` 外，也认 10/13 位毫秒时间戳：
 * 东八区加 8 小时后取 UTC 日期，就是接口所在市场的那一天，且不依赖进程时区。
 */
export function parseNavDate(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return parseNavDate(String(Math.trunc(value)));
  }
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;

  if (/^\d{13}$/.test(raw)) {
    const shifted = new Date(Number(raw) + 8 * 60 * 60 * 1000);
    const iso = shifted.toISOString().slice(0, 10);
    return iso === "1970-01-01" ? undefined : iso;
  }
  if (/^\d{10}$/.test(raw)) {
    const shifted = new Date(Number(raw) * 1000 + 8 * 60 * 60 * 1000);
    const iso = shifted.toISOString().slice(0, 10);
    return iso === "1970-01-01" ? undefined : iso;
  }

  const dashed = raw.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/);
  if (dashed) {
    return `${dashed[1]}-${dashed[2]!.padStart(2, "0")}-${dashed[3]!.padStart(2, "0")}`;
  }
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  return undefined;
}

function readName(data: unknown, path: string): string | undefined {
  if (!path) return undefined;
  const raw = String(readJsonPath(data, path) ?? "").trim();
  return raw || undefined;
}

function parseSeries(data: unknown, config: FundJsonParserConfig, ctx?: NavParseContext): NavValue | null {
  const list = readJsonPath(data, config.seriesPath);
  if (!Array.isArray(list) || list.length === 0) return null;

  const rows: NavValue[] = [];
  for (const item of list) {
    const nav = parseNavNumber(readJsonPath(item, config.seriesNavPath));
    const date = parseNavDate(readJsonPath(item, config.seriesDatePath));
    if (!nav || !date) continue;
    rows.push({
      nav,
      date,
      cumNav: config.seriesCumNavPath
        ? parseNavNumber(readJsonPath(item, config.seriesCumNavPath))
        : undefined,
    });
  }
  if (rows.length === 0) return null;

  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const target = ctx?.targetDate;
  if (!target) return rows[0]!;

  // 只认「目标日当天或之前」的最新一条。找不到就返回 null 交给下一条源，
  // 不要退化成「最近一条」——那会让确认日拿到未来的净值。
  return rows.find((row) => row.date <= target) ?? null;
}

/** 按配置从 JSON 报文里取净值；取不到返回 `null`。 */
export function parseFundJsonNav(
  data: unknown,
  config: FundJsonParserConfig,
  ctx?: NavParseContext,
): NavValue | null {
  if (config.dateMode === "series") {
    const series = parseSeries(data, config, ctx);
    if (!series) return null;
    const name = readName(data, config.namePath);
    return name ? { ...series, name } : series;
  }

  const nav = parseNavNumber(readJsonPath(data, config.navPath));
  const date = parseNavDate(readJsonPath(data, config.datePath)) ?? ctx?.targetDate;
  if (!nav || !date) return null;

  return {
    nav,
    date,
    cumNav: config.cumNavPath ? parseNavNumber(readJsonPath(data, config.cumNavPath)) : undefined,
    name: readName(data, config.namePath),
  };
}
