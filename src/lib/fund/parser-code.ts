/**
 * 净值源的「解析器」清单。
 *
 * 解析器决定怎么拆返回内容。`queryFundNav` 只挑认得出的源（`queryApi.ts` 的
 * `resolveParser`），认不出的源永远不参与取数，界面上却仍显示「已启用」。
 *
 * 内置四个解析器写死在代码里，只认那几家的报文形状；`json` 是配置驱动的那一类：
 * 字段路径、鉴权方式都存在 `FundQueryApi.parserConfig`，换一家「GET + JSON + 静态
 * key」的 API 不用改代码。需要签名、需要 POST、返回 HTML 的源仍然只能加内置解析器。
 *
 * 注意标识位：2026-11 之前解析器就等于 `FundQueryApi.code`；现在解析器存 `parser`
 * 列，`code` 退化成行标识（自建源会是 `custom_*`）。读解析器一律用
 * `api.parser ?? api.code`，不要直接看 `code`。
 */

export type FundParserCode = "eastmoney" | "eastmoney_history" | "danjuan" | "alipay" | "json";

export const FUND_PARSER_CODES: readonly FundParserCode[] = [
  "eastmoney",
  "eastmoney_history",
  "danjuan",
  "alipay",
  "json",
] as const;

const PARSER_CODE_SET: ReadonlySet<string> = new Set<string>(FUND_PARSER_CODES);

export function isKnownFundParserCode(code: string | null | undefined): code is FundParserCode {
  return typeof code === "string" && PARSER_CODE_SET.has(code);
}

/**
 * 域名 → 解析器。只认精确的已知域名：`eastmoney` 家族里实时估值与历史净值是两个
 * parser，用「包含 eastmoney」这种宽松匹配会把 f10/lsjz 错判成实时那个。
 */
const HOST_RULES: ReadonlyArray<{ host: RegExp; code: FundParserCode }> = [
  { host: /^api\.fund\.eastmoney\.com$/i, code: "eastmoney_history" },
  { host: /^fundgz\.1234567\.com\.cn$/i, code: "eastmoney" },
  { host: /^push2\.eastmoney\.com$/i, code: "eastmoney" },
  { host: /^danjuanfunds\.com$/i, code: "danjuan" },
  { host: /^danjuanapp\.com$/i, code: "danjuan" },
  { host: /^fundmobapi\.alipay\.com$/i, code: "alipay" },
];

/**
 * 从请求地址推断解析器，识别不了返回 `null`。
 *
 * 返回 null 时调用方必须让用户手动选，不能猜一个默认值 —— 猜错等于又造一条静默失效的源。
 * `{date}` 是历史日期的特征：东方财富的地址带上它就只能用历史净值解析器。
 */
export function inferFundParserCode(baseUrl: string | null | undefined): FundParserCode | null {
  const raw = (baseUrl ?? "").trim();
  if (!raw) return null;

  let host = "";
  try {
    host = new URL(raw).hostname;
  } catch {
    return null;
  }

  const rule = HOST_RULES.find((item) => item.host.test(host));
  if (!rule) return null;
  if (rule.code === "eastmoney" && raw.includes("{date}")) return "eastmoney_history";
  return rule.code;
}
