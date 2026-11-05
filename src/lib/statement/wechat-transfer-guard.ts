/**
 * 微信账单「收支大类 → 转账」守卫。
 *
 * 微信导出的账单把「交易类型」（转账 / 商户消费 / 红包 / 二维码收款…）和「交易对方」
 * 都写在原文里，但归一化后的标准 11 列没有位置放它们：
 * - 「交易对方」若直接进标准列会被 institution 别名抢走（institution = 微信才是账单来源）；
 * - 「交易类型」若进 `explicitType` 别名，「转账」会把整行自动判成转账，与「默认按收支记、
 *   由用户手改」的既有口径冲突。
 *
 * 所以 wechat-template 在归一化行末尾追加两列（原交易类型 / 原交易对方），仅仅供预览用。
 * 用户在预览里把某条「收支大类」改成转账时按下面的口径判断（2026-11-05 用户裁定）：
 * - 原「交易类型」不含转账（商户消费 / 红包 / 二维码收款 / 空值）→ 禁止改成转账；
 * - 原交易类型是转账但没有「交易对象」→ 禁止改成转账（没有对向账户，说不清是谁的钱）；
 * - 原交易类型是转账且有交易对象 → 允许，并按「<交易对象>的往来款」填对向账户，
 *   同时提示将新建这个往来款账户。账户名取「交易对象」原文（不剥括号备注）。
 */
import { findStatementHeaderIndex } from "@/lib/statement/header-utils";

/** 归一化行里追加的「交易类型」列名（微信专用，刻意不叫「交易类型」以免被标准别名命中）。 */
export const WECHAT_RAW_TRANSACTION_TYPE_HEADER = "原交易类型";
/** 归一化行里追加的「交易对方」列名（不叫「交易对方」以免被 institution 别名抢走）。 */
export const WECHAT_RAW_COUNTERPARTY_HEADER = "原交易对方";

/** 往来款账户后缀，与 statementImportPreview.liabilityAccountName 的口径一致。 */
const SETTLEMENT_ACCOUNT_SUFFIX = "的往来款";

/** 微信「交易类型」里算转账的写法：「转账」「微信转账」「转账收款」。 */
const WECHAT_TRANSFER_TYPE_RE = /转账|转帐|transfer/i;

export type WechatTransferMeta = {
  /** 该行来自微信账单（归一化行带「原交易类型」列）；值为 false/缺省时按非微信行放行。 */
  wechatStatement?: boolean;
  /** 微信账单原文「交易类型」。 */
  statementTransactionType?: string;
  /** 微信账单原文「交易对方」（即界面上说的「交易对象」）。 */
  statementCounterparty?: string;
};

export type WechatMetaHeaderIndexes = {
  transactionTypeIndex: number;
  counterpartyIndex: number;
};

/**
 * 从归一化表头里解析微信元信息列号；没有「原交易类型」列的账单（非微信）返回 null。
 */
export function wechatMetaHeaderIndexes(headers: readonly string[]): WechatMetaHeaderIndexes | null {
  const transactionTypeIndex = findStatementHeaderIndex(headers, [WECHAT_RAW_TRANSACTION_TYPE_HEADER]);
  if (transactionTypeIndex < 0) return null;
  return {
    transactionTypeIndex,
    counterpartyIndex: findStatementHeaderIndex(headers, [WECHAT_RAW_COUNTERPARTY_HEADER]),
  };
}

export function wechatMetaFromRow(
  row: readonly string[],
  indexes: WechatMetaHeaderIndexes | null,
): WechatTransferMeta {
  if (!indexes) return {};
  const transactionType = String(row[indexes.transactionTypeIndex] ?? "").trim();
  const counterparty = indexes.counterpartyIndex >= 0
    ? String(row[indexes.counterpartyIndex] ?? "").trim()
    : "";
  return {
    // 有「原交易类型」列就是微信账单：交易类型为空也算微信行（空值同样不能改转账）。
    wechatStatement: true,
    statementTransactionType: transactionType || undefined,
    statementCounterparty: counterparty || undefined,
  };
}

export function isWechatTransferTransactionType(value: string | null | undefined) {
  const text = String(value ?? "").trim();
  return Boolean(text) && WECHAT_TRANSFER_TYPE_RE.test(text);
}

/** 往来款账户名：「<交易对象>的往来款」（交易对象原文照用，含括号备注）。 */
export function buildWechatSettlementAccountName(counterparty: string | null | undefined) {
  const name = String(counterparty ?? "").trim();
  return name ? `${name}${SETTLEMENT_ACCOUNT_SUFFIX}` : "";
}

export type WechatTransferGuard =
  /** 不是微信账单行，不干预。 */
  | { kind: "not-wechat" }
  /** 微信行原文「交易类型」不是转账：禁止改成转账。 */
  | { kind: "not-transfer-type"; transactionType: string }
  /** 微信行没有「交易对象」：禁止改成转账。 */
  | { kind: "missing-counterparty" }
  /** 微信转账：按交易对象代填「<交易对象>的往来款」。 */
  | { kind: "transfer"; counterparty: string; counterAccountName: string };

export function resolveWechatTransferGuard(meta: WechatTransferMeta | null | undefined): WechatTransferGuard {
  const transactionType = String(meta?.statementTransactionType ?? "").trim();
  if (!meta?.wechatStatement && !transactionType) return { kind: "not-wechat" };
  // 只有原文写着转账才能改成转账：商户消费 / 红包 / 二维码收款 / 空值一律挡住。
  if (!isWechatTransferTransactionType(transactionType)) {
    return { kind: "not-transfer-type", transactionType };
  }
  const counterparty = String(meta?.statementCounterparty ?? "").trim();
  if (!counterparty) return { kind: "missing-counterparty" };
  return {
    kind: "transfer",
    counterparty,
    counterAccountName: buildWechatSettlementAccountName(counterparty),
  };
}

/**
 * 被守卫挡住时的提示（i18n key + 参数）。
 * 预览弹窗与批量导入页共用同一套口径，避免两处文案漂移。
 */
export function wechatTransferBlockMessage(
  guard: WechatTransferGuard,
): { key: string; params?: { type: string } } | null {
  if (guard.kind === "not-transfer-type") {
    return guard.transactionType
      ? { key: "statementImportPreview.wechatTransferBlockedNotTransfer", params: { type: guard.transactionType } }
      : { key: "statementImportPreview.wechatTransferBlockedNoType" };
  }
  if (guard.kind === "missing-counterparty") {
    return { key: "statementImportPreview.wechatTransferNoCounterparty" };
  }
  return null;
}
