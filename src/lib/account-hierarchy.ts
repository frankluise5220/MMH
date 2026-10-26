import { normalizeCurrency } from "@/lib/currency";

/**
 * 多币种父账户（聚合账户）层级 —— 纯函数部分，客户端与服务端共用。
 *
 * 产品口径（2026-10-18 用户裁定）：
 * - **父账户 = 统计单元**：参与资产/净值/报表汇总，余额由子户按账簿本位币折算；
 * - **子账户 = 记账单元**：按币种拆分，明细（`TxRecord`）只挂在子账户上；
 * - 父账户自身没有明细，也**不能直接记账**（`isPostableAccount` 为 false）。
 */
type AccountHierarchyLike = {
  id: string;
  name?: string | null;
  currency?: string | null;
  parentId?: string | null;
  isAggregate?: boolean | null;
};

/** 父账户（聚合账户）：只参与统计。 */
export function isAggregateAccount(account?: AccountHierarchyLike | null): boolean {
  return account?.isAggregate === true;
}

/** 可记账账户：子账户或未升级的普通账户。写入路径必须落到这一级。 */

/**
 * 统计单元：没有父账户的那一级。子账户已经被父账户代表，再计入就是双计，
 * 所以资产/净值/账户合计一律先过这一层过滤。
 */
function isStatisticAccount(account?: AccountHierarchyLike | null): boolean {
  return !!account && !account.parentId;
}


/**
 * 币种子账户的默认名：`原名 · 币种`（2026-10-18 用户裁定）。
 * 一律用 ISO 代码入库 —— 中文「美元」写进 `Account.name` 后切换界面语言也不会变。
 */
export function multiCurrencyChildName(parentName: string | null | undefined, currency: string | null | undefined) {
  const name = String(parentName ?? "").trim();
  const code = normalizeCurrency(currency);
  return name ? `${name} · ${code}` : code;
}

/** 升/降级时同步 `TxRecord` 的账户名快照（与账户合并路由同一套做法）。 */
