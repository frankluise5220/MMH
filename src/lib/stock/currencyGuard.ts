import { normalizeCurrency } from "@/lib/currency";
import { defaultStockCurrencyForMarket, normalizeStockMarket } from "@/lib/stock/market";

/**
 * 股票记账的币种一致性校验。
 *
 * 记账层不做换汇：现金腿的币种直接取资金账户、金额原样写入（见 stock/cashFlow.ts），
 * 持仓报表的行币种直接取股票账户（见 server/stock-holding-report.ts）。所以港股必须
 * 用港币账户买、美股必须用美元账户买，否则市值会被当成人民币记进总资产。
 *
 * A 股不参与校验：历史账全部是 CNY 账户，且本位币就是 CNY，不换算也不出错。
 */
export type StockCurrencyMismatch = {
  code: "MARKET_CURRENCY_MISMATCH";
  market: string;
  expectedCurrency: string;
  stockAccountCurrency: string | null;
  cashAccountCurrency: string | null;
  /** 哪一头对不上，前端据此把提示落在对应的下拉旁边。 */
  field: "stockAccount" | "cashAccount";
};

export function stockMarketCurrencyMismatch(params: {
  market: unknown;
  stockAccountCurrency?: string | null;
  /** 传 null / undefined 表示这笔动作没有资金腿（送股、转入），只校验股票账户。 */
  cashAccountCurrency?: string | null;
}): StockCurrencyMismatch | null {
  const market = normalizeStockMarket(params.market);
  if (market === "CN") return null;

  const expectedCurrency = defaultStockCurrencyForMarket(market);
  const stockAccountCurrency = params.stockAccountCurrency
    ? normalizeCurrency(params.stockAccountCurrency)
    : null;
  const cashAccountCurrency = params.cashAccountCurrency
    ? normalizeCurrency(params.cashAccountCurrency)
    : null;

  if (stockAccountCurrency && stockAccountCurrency !== expectedCurrency) {
    return {
      code: "MARKET_CURRENCY_MISMATCH",
      market,
      expectedCurrency,
      stockAccountCurrency,
      cashAccountCurrency,
      field: "stockAccount",
    };
  }
  if (cashAccountCurrency && cashAccountCurrency !== expectedCurrency) {
    return {
      code: "MARKET_CURRENCY_MISMATCH",
      market,
      expectedCurrency,
      stockAccountCurrency,
      cashAccountCurrency,
      field: "cashAccount",
    };
  }
  return null;
}

export function stockCurrencyMismatchMessage(mismatch: StockCurrencyMismatch): string {
  if (mismatch.field === "stockAccount") {
    return `${mismatch.market} 市场按 ${mismatch.expectedCurrency} 计价，当前股票账户是 ${mismatch.stockAccountCurrency ?? "未设置"} 账户。请改用 ${mismatch.expectedCurrency} 股票账户记账`;
  }
  return `${mismatch.market} 市场按 ${mismatch.expectedCurrency} 计价，当前资金账户是 ${mismatch.cashAccountCurrency ?? "未设置"} 账户。请选择 ${mismatch.expectedCurrency} 资金账户（没有就先给券商资金账户加一个币种子户）`;
}
