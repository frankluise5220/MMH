// MMH 标准基金导入文件（CSV）。
//
// 账单里常常只有基金名称（「蚂蚁财富-摩根标普500指数(QDII)A-买入」）而没有 6 位代码，
// 而基金导入链路硬性要求 /^\d{6}$/。本模块负责把名称补齐成代码，再拼成基金导入能认的 CSV。
//
// 与具体账单平台无关：支付宝、财智、手工整理的清单都走同一份格式，
// 所以归在 fund 域，不放在任何一家 statement 模板下面。

export type FundImportFileTrade = {
  date: string;
  amount: number;
  /** buy / redeem / buy_failed —— 与基金导入的分类取值一致。 */
  subtype: string;
  fundName: string;
  fundAccount: string;
  cashAccount: string;
};

/** 名称 → 6 位基金代码：本地 FundProfile / FundNavCache 优先，查不到再走线上反查。 */
export async function resolveFundCodesByNames(names: readonly string[]) {
  const unique = Array.from(new Set(names.filter(Boolean)));
  if (unique.length === 0) return new Map<string, string>();
  try {
    const response = await fetch("/api/v1/fund/resolve-by-names", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ names: unique }),
    });
    const data = await response.json() as { items?: Array<{ name?: string; fundCode?: string | null }> };
    const codes = new Map<string, string>();
    for (const item of data.items ?? []) {
      if (item.name && item.fundCode) codes.set(item.name, item.fundCode);
    }
    return codes;
  } catch {
    return new Map<string, string>();
  }
}

function csvCell(value: string) {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * 把基金买卖行拼成基金导入认识的 CSV。
 * 份额不用管 —— 金额 + 净值已足够，后端会按净值折算份额。
 */
export async function buildFundImportFile(
  trades: readonly FundImportFileTrade[],
  sourceFileName: string,
): Promise<File> {
  const codes = await resolveFundCodesByNames(trades.map((trade) => trade.fundName));
  const header = ["日期", "基金账户", "资金账户", "基金代码", "金额", "分类", "备注"];
  const body = trades.map((trade) => [
    trade.date,
    trade.fundAccount,
    trade.cashAccount,
    codes.get(trade.fundName) ?? "",
    String(trade.amount),
    trade.subtype,
    trade.fundName,
  ]);
  const csv = [header, ...body].map((row) => row.map(csvCell).join(",")).join("\n");
  const baseName = sourceFileName.replace(/\.[^.]+$/, "");
  // BOM 让 decodeTextFile 一定能按 UTF-8 解回来。
  return new File([`\uFEFF${csv}\n`], `${baseName}-基金交易.csv`, { type: "text/csv" });
}
