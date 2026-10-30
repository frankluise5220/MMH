// 账单里已经交给「基金交易」页签的行，必须从资金收支页签里剔掉：
// 同一笔钱不能既记基金又记流水。
//
// 按原文比对（含重复笔数），不依赖行号 —— 各模板怎么过滤行、过滤掉多少行都不影响。
// 只要求 trade 带 rawText，与具体账单平台的字段无关。

export type FundTradeRowRef = { rawText: string };

export function excludeFundTradeRows(
  rows: readonly string[][],
  trades: readonly FundTradeRowRef[],
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
