// 支付宝账单 → 「基金交易」页签的路由。
//
// 这里只做支付宝专属的部分：认支付宝的列、按「交易分类 / 交易对方 / 商品说明」
// 判断哪几行是基金买卖。抽出代码、拼 CSV、剔行都是共性的，在
// `@/lib/fund/fund-import-file` 与 `@/lib/statement/fund-trade-split`。

import { buildFundImportFile } from "@/lib/fund/fund-import-file";
import {
  extractAlipayFundTrades,
  type AlipayFundTrade,
  type AlipayFundTradeSheet,
} from "@/lib/statement/alipay-fund-trade";
import { guessOwnerFromFilename } from "@/lib/statement/owner-from-filename";

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
    ownerHint || guessOwnerFromFilename(sourceFileName),
  );
  if (trades.length === 0) return null;
  return { file: await buildFundImportFile(trades, sourceFileName), count: trades.length, trades };
}
