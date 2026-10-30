// 支付宝账单 → 标准基金导入文件。
//
// 账单里只有基金名称（「蚂蚁财富-摩根标普500指数(QDII)A-买入」），没有 6 位基金代码，
// 而基金导入链路硬性要求 /^\d{6}$/。这里负责两件事：把账单里的基金买卖行抽出来，
// 以及按名称反查代码后拼成基金导入认识的 CSV。
//
// 首页「导入」与「批量导入」两个入口共用这一段，避免账单里的基金买卖在其中一个
// 入口只能落成转账（用户报告「蚂蚁财富-摩根标普500指数(QDII)A-买入 没识别出来」）。

import {
  extractAlipayFundTrades,
  type AlipayFundTrade,
  type AlipayFundTradeSheet,
} from "@/lib/statement/alipay-fund-trade";
import { guessAlipayOwnerFromFilename } from "@/lib/statement/alipay-template";

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
  trades: readonly AlipayFundTrade[],
  sourceFileName: string,
): Promise<File> {
  const codes = await resolveFundCodesByNames(trades.map((trade) => trade.fundName));
  const header = ["\u65e5\u671f", "\u57fa\u91d1\u8d26\u6237", "\u8d44\u91d1\u8d26\u6237", "\u57fa\u91d1\u4ee3\u7801", "\u91d1\u989d", "\u5206\u7c7b", "\u5907\u6ce8"];
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
  return new File([`\uFEFF${csv}\n`], `${baseName}-\u57fa\u91d1\u4ea4\u6613.csv`, { type: "text/csv" });
}

/**
 * 从账单原始行里剔掉已经交给基金页签的那些行：同一笔钱不能既记基金又记流水。
 * 行按原文比对（含重复笔数），不依赖行号，模板怎么过滤行都不受影响。
 */
export function excludeFundTradeRows(
  rows: readonly string[][],
  trades: readonly AlipayFundTrade[],
): string[][] {
  if (trades.length === 0) return rows as string[][];
  const remaining = new Map<string, number>();
  for (const trade of trades) {
    remaining.set(trade.rawText, (remaining.get(trade.rawText) ?? 0) + 1);
  }
  return rows.filter((row) => {
    const key = row.join(",");
    const left = remaining.get(key) ?? 0;
    if (left <= 0) return true;
    remaining.set(key, left - 1);
    return false;
  });
}

export type AlipayFundBillRoute = {
  file: File;
  count: number;
  /** 抽出来的基金买卖行：资金收支页签要按 rawText 把同一批行剔除，避免记两次。 */
  trades: AlipayFundTrade[];
};

/**
 * 账单工作簿 → 基金导入文件。
 * 返回 null 表示这张账单里没有可识别的基金买卖（余额宝收益、提现等仍走普通流水）。
 */
export async function routeAlipayFundBill(
  sheets: readonly AlipayFundTradeSheet[],
  sourceFileName: string,
  ownerHint = "",
): Promise<AlipayFundBillRoute | null> {
  const trades = extractAlipayFundTrades(
    sheets,
    ownerHint || guessAlipayOwnerFromFilename(sourceFileName),
  );
  if (trades.length === 0) return null;
  return { file: await buildFundImportFile(trades, sourceFileName), count: trades.length, trades };
}
