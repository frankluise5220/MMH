/**
 * 持仓页当前选中的股票（模块级快照，仅客户端）。
 *
 * 持仓面板的选中行是组件内部 state，胶囊菜单的「卖出 / 分红」在另一个 client 组件里，
 * 两者之间没有 props 通路（页面是 RSC）。这里放一个极小的快照，让记账入口能默认带上
 * 用户正在看的那只股票，不必再点一次下拉。
 *
 * 只在选中的股票属于同一只股票账户时才使用，避免离开持仓页后把别的账户的选择带进来。
 */
export type SelectedStockSnapshot = {
  accountId: string;
  securityId: string;
  market: string;
  stockCode: string;
  stockName: string;
  quantity: number;
};

let selectedStock: SelectedStockSnapshot | null = null;

export function setSelectedStock(next: SelectedStockSnapshot | null) {
  selectedStock = next;
}

export function getSelectedStock(): SelectedStockSnapshot | null {
  return selectedStock;
}

/** 取「属于这个股票账户」的选中股票；账户对不上（或没有选中）时返回 null。 */
export function selectedStockForAccount(accountId?: string | null): SelectedStockSnapshot | null {
  if (!accountId || !selectedStock) return null;
  if (selectedStock.accountId !== accountId) return null;
  return selectedStock;
}
