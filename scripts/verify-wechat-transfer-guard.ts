/**
 * 守卫：微信账单「收支大类 → 转账」（src/lib/statement/wechat-transfer-guard.ts）。
 *
 * 用户口径（2026-11-05 裁定）：
 * - 只有原文「交易类型」含转账才能把收支大类改成转账；商户消费 / 红包 / 二维码收款 / 空值一律禁止；
 * - 原文是转账但没有「交易对象」→ 也禁止（改出来没有对向账户）；
 * - 允许时按「<交易对象>的往来款」填对向账户，账户名取交易对象原文（不剥括号备注）；
 * - 非微信账单行不受影响（not-wechat）。
 *
 * 运行：npm run check:wechat-transfer-guard
 */
import {
  buildWechatSettlementAccountName,
  isWechatTransferTransactionType,
  resolveWechatTransferGuard,
  wechatMetaFromRow,
  wechatMetaHeaderIndexes,
  wechatTransferBlockMessage,
} from "../src/lib/statement/wechat-transfer-guard";
import { suggestTransferCounterAccountName } from "../src/lib/statement/transfer-counter-account";

let failed = 0;
function check(label: string, ok: boolean, extra = "") {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? ` :: ${extra}` : ""}`);
}

// —— 元信息列解析 ——
const headers = ["日期", "类型", "金额", "原交易类型", "原交易对方"];
const indexes = wechatMetaHeaderIndexes(headers);
check("表头解析出微信两列", indexes?.transactionTypeIndex === 3 && indexes?.counterpartyIndex === 4);
check("非微信表头返回 null", wechatMetaHeaderIndexes(["日期", "类型", "金额"]) === null);
check(
  "行 → 元信息",
  JSON.stringify(wechatMetaFromRow(["2026-01-01", "转账", "10", "转账", "小妖王 (清欢渡)"], indexes)) ===
    JSON.stringify({ wechatStatement: true, statementTransactionType: "转账", statementCounterparty: "小妖王 (清欢渡)" }),
);
check(
  "空交易类型仍标记为微信行",
  wechatMetaFromRow(["2026-01-01", "", "10", "", ""], indexes).wechatStatement === true,
);

// —— 交易类型判定 ——
for (const type of ["转账", "微信转账", "转账收款", "Transfer"]) {
  check(`交易类型「${type}」算转账`, isWechatTransferTransactionType(type));
}
for (const type of ["商户消费", "红包", "二维码收款", "", "   "]) {
  check(`交易类型「${type}」不算转账`, !isWechatTransferTransactionType(type));
}

// —— 账户名口径（交易对象原文） ——
check(
  "账户名原文照用",
  buildWechatSettlementAccountName("小妖王 (清欢渡)") === "小妖王 (清欢渡)的往来款",
);
check("空交易对象不产账户名", buildWechatSettlementAccountName("  ") === "");

// —— 守卫分支 ——
check("非微信行放行", resolveWechatTransferGuard({}).kind === "not-wechat");
check("非微信行（无列但带交易类型）按微信处理", resolveWechatTransferGuard({ statementTransactionType: "转账", statementCounterparty: "史美玲" }).kind === "transfer");
check(
  "转账 + 交易对象 → transfer",
  resolveWechatTransferGuard({ wechatStatement: true, statementTransactionType: "转账", statementCounterparty: "TK-史美玲 (smiling)" }).kind === "transfer",
);
check(
  "商户消费 → 禁止",
  resolveWechatTransferGuard({ wechatStatement: true, statementTransactionType: "商户消费", statementCounterparty: "肯德基" }).kind === "not-transfer-type",
);
check(
  "二维码收款 → 禁止",
  resolveWechatTransferGuard({ wechatStatement: true, statementTransactionType: "二维码收款", statementCounterparty: "张三" }).kind === "not-transfer-type",
);
check(
  "微信行空交易类型 → 禁止",
  resolveWechatTransferGuard({ wechatStatement: true, statementCounterparty: "张三" }).kind === "not-transfer-type",
);
check(
  "转账但无交易对象 → 禁止",
  resolveWechatTransferGuard({ wechatStatement: true, statementTransactionType: "转账" }).kind === "missing-counterparty",
);

// —— 提示文案 ——
check(
  "非转账类型提示",
  wechatTransferBlockMessage({ kind: "not-transfer-type", transactionType: "商户消费" })?.key === "statementImportPreview.wechatTransferBlockedNotTransfer",
);
check(
  "空交易类型提示",
  wechatTransferBlockMessage({ kind: "not-transfer-type", transactionType: "" })?.key === "statementImportPreview.wechatTransferBlockedNoType",
);
check(
  "缺交易对象提示",
  wechatTransferBlockMessage({ kind: "missing-counterparty" })?.key === "statementImportPreview.wechatTransferNoCounterparty",
);
check(
  "放行的行没有提示",
  wechatTransferBlockMessage(resolveWechatTransferGuard({ wechatStatement: true, statementTransactionType: "转账", statementCounterparty: "史美玲" })) === null &&
    wechatTransferBlockMessage({ kind: "not-wechat" }) === null,
);

// —— 非微信账单（标准模板 / 银行流水）改成转账时的对向账户口径 ——
check("空原文不产账户名", suggestTransferCounterAccountName("  ") === "");
check(
  "人名 → 往来款",
  suggestTransferCounterAccountName("小妖王 (清欢渡)") === "小妖王 (清欢渡)的往来款",
);
check(
  "已带括号备注的人名 → 往来款",
  suggestTransferCounterAccountName("陈媛媛 (柠檬草)") === "陈媛媛 (柠檬草)的往来款",
);
check(
  "已是往来款口径 → 原样",
  suggestTransferCounterAccountName("张三的往来款") === "张三的往来款" &&
    suggestTransferCounterAccountName("赵六的应收款") === "赵六的应收款",
);
check(
  "银行卡账户 → 原样",
  suggestTransferCounterAccountName("招商银行储蓄卡(9447)") === "招商银行储蓄卡(9447)",
);

console.log(failed === 0 ? "\ncheck:wechat-transfer-guard ok" : `\n${failed} 条断言失败`);
process.exit(failed === 0 ? 0 : 1);
