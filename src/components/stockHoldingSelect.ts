import type { SmartSelectOption } from "@/components/SmartSelect";

/**
 * 持仓下拉的组头 id。只在下拉内部用来串 parentId，不会写进业务数据。
 * 组头必须是 isHeader（不可选、带折叠箭头），子项靠 parentId 认父；
 * 少了 parentId，箭头会翻但列表一项都不会收起。
 */
export const STOCK_HOLDING_GROUP_ACTIVE = "stock-holdings-active";
export const STOCK_HOLDING_GROUP_CLOSED = "stock-holdings-closed";

/**
 * 默认收起的分组：清仓的股票只在补录历史（股息税补扣等）时才找，
 * 不该占满常用列表；选中它时 SmartSelect 会自动把这一组展开。
 * 对应 SmartSelect behavior 的通用属性 defaultCollapsedGroupIds。
 */
export const STOCK_HOLDING_COLLAPSED_GROUPS = [STOCK_HOLDING_GROUP_CLOSED];

export type StockHoldingSelectRow = {
  securityId: string;
  stockCode: string;
  stockName?: string | null;
  quantity: number;
};

export type StockHoldingSelectLabels = {
  active: string;
  closed: string;
};

/**
 * 把持仓列表拼成「当前持仓 / 已清仓」两组的 SmartSelect 选项。
 * 卖出、分红、股本变动、股息税共用同一份构造，别在各自的下拉里再手搓一遍
 * （手搓时最容易漏掉 parentId，折叠箭头就只剩动画）。
 */
export function buildStockHoldingSelectOptions(
  rows: StockHoldingSelectRow[],
  labels: StockHoldingSelectLabels,
  formatSubLabel: (row: StockHoldingSelectRow, closed: boolean) => string | undefined,
  extras: SmartSelectOption[] = [],
): SmartSelectOption[] {
  const active = rows.filter((row) => Number(row.quantity) > 0);
  const closed = rows.filter((row) => !(Number(row.quantity) > 0));
  const options: SmartSelectOption[] = [];

  const pushGroup = (
    headerId: string,
    label: string,
    groupRows: StockHoldingSelectRow[],
    isClosedGroup: boolean,
  ) => {
    if (groupRows.length === 0) return;
    options.push({ id: headerId, label, isHeader: true });
    for (const row of groupRows) {
      options.push({
        id: row.securityId,
        label: row.stockName?.trim() || row.stockCode,
        parentId: headerId,
        subLabel: formatSubLabel(row, isClosedGroup),
      });
    }
  };

  pushGroup(STOCK_HOLDING_GROUP_ACTIVE, labels.active, active, false);
  pushGroup(STOCK_HOLDING_GROUP_CLOSED, labels.closed, closed, true);

  // 编辑历史行时那只股票可能已经不在持仓表里（换过账户、或资料被清理）。
  // 补进来的选项挂「已清仓」——它本来就不是当前持仓；选中它时该组会自动展开。
  for (const extra of extras) {
    if (options.some((option) => option.id === extra.id)) continue;
    const parentId = extra.parentId
      ?? (options.some((option) => option.id === STOCK_HOLDING_GROUP_CLOSED)
        ? STOCK_HOLDING_GROUP_CLOSED
        : undefined);
    options.push({ ...extra, parentId });
  }

  return options;
}
