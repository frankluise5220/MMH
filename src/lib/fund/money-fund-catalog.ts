/**
 * 电子钱包「一键创建货基账户」的候选货币基金目录。
 *
 * 货币基金不是固定的一只：支付宝余额宝背后同时对接了多只货币基金，用户在余额宝里
 * 切换过之后，实际持有的可能是其中任意一只（2026-11-19 用户裁定）。所以一键创建
 * 不能再写死 000198，必须让用户先选是哪一只。
 *
 * 目录只收录「余额宝实际对接」的货币基金，名称按基金公司披露的简称记录；
 * 名单会变，因此界面另外提供「手动输入代码」的入口，服务端也接受任意 6 位代码。
 *
 * 这张表是纯常量，客户端（选择器）与服务端（账户命名）共用，不要在这里引入服务端依赖。
 */
export interface MoneyFundCatalogEntry {
  /** 6 位基金代码 */
  code: string;
  /** 基金简称（与 FundProfile.fundName 同一口径） */
  name: string;
  /** 基金管理人 */
  company: string;
  /**
   * 建账户时的名称后缀。不填就用 name。
   * 000198 沿用历史的「余额宝货币基金」，避免同一只基金建出两个不同名字的账户。
   */
  accountSuffix?: string;
}

/** 支付宝余额宝对接的货币基金（币种均为人民币普通货币基金）。 */
export const ALIPAY_BALANCE_BAO_FUNDS: readonly MoneyFundCatalogEntry[] = [
  { code: "000198", name: "天弘余额宝货币", company: "天弘基金", accountSuffix: "余额宝货币基金" },
  { code: "000559", name: "诺安天天宝A", company: "诺安基金" },
  { code: "001211", name: "中欧滚钱宝货币A", company: "中欧基金" },
  { code: "050003", name: "博时现金收益货币A", company: "博时基金" },
  { code: "040038", name: "华安日日鑫货币A", company: "华安基金" },
  { code: "003515", name: "国泰利是宝货币", company: "国泰基金" },
  { code: "000380", name: "景顺长城景益货币A", company: "景顺长城基金" },
  { code: "001134", name: "广发天天利货币E", company: "广发基金" },
  { code: "180008", name: "银华货币A", company: "银华基金" },
  { code: "090022", name: "大成现金增利货币A", company: "大成基金" },
];

/** 一键创建时的默认基金：天弘余额宝货币。 */
export const DEFAULT_LINKED_MONEY_FUND_CODE = "000198";

export function findMoneyFundCatalogEntry(code: string | null | undefined): MoneyFundCatalogEntry | null {
  const normalized = String(code ?? "").trim();
  if (!normalized) return null;
  return ALIPAY_BALANCE_BAO_FUNDS.find((entry) => entry.code === normalized) ?? null;
}
