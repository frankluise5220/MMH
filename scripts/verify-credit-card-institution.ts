/**
 * 信用卡账单的机构名 / 持卡人识别守卫。
 *
 * 2026-11-20 用户报「0.1.87 的历史更新里已经写了这两条修复，实际还在出问题」：
 * - 农商体系（农村商业银行 / 农商银行 / 农村信用社 / 江苏农信）没有统一到账本
 *   的「农商银行」口径，通用 HTML 模板拼出「信用卡信用卡」；
 * - 「尊敬的 付斌 先生，您好」这类写法认不出持卡人，账单落不到既有账户。
 *
 * 覆盖：发卡行识别、持卡人识别、账户名收敛、落回既有账户。
 */
import { detectStatementBankName, isRuralBankName } from "../src/lib/statement/credit-card-institution";
import { extractStatementOwnerName } from "../src/lib/statement/statement-owner-name";
import { parseImportPaymentCardAccount, resolveImportAccountFromList } from "../src/lib/account-import-match";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  if (Object.is(actual, expected)) {
    console.log(`PASS  ${label}`);
    return;
  }
  failures += 1;
  console.log(`FAIL  ${label}  期望 ${String(expected)}，实际 ${String(actual)}`);
}

// 发卡行：农商体系一律「农商银行」
check("江苏农村商业银行 -> 农商银行", detectStatementBankName("江苏农村商业银行信用卡电子账单"), "农商银行");
check("农商银行简写 -> 农商银行", detectStatementBankName("江苏省农商银行"), "农商银行");
check("农村信用社 -> 农商银行", detectStatementBankName("XX市农村信用社 对账单"), "农商银行");
check("江苏农信 -> 农商银行", detectStatementBankName("江苏农信 电子账单"), "农商银行");
check("江苏农商信用卡 -> 农商银行", detectStatementBankName("江苏农商信用卡"), "农商银行");
check("非农商银行不受影响", detectStatementBankName("招商银行信用卡"), "招商银行");
check("中国工商银行 -> 工商银行", detectStatementBankName("中国工商银行"), "工商银行");
// 「信用卡」不是机构名：认不出就该留空，由账单头部的机构行补齐
check("信用卡不当作机构名", detectStatementBankName("信用卡 电子账单 2026-11"), "");
check("isRuralBankName 农商", isRuralBankName("江苏农村商业银行"), true);
check("isRuralBankName 非农商", isRuralBankName("招商银行"), false);

// 持卡人
check("尊敬的 付斌 先生，您好", extractStatementOwnerName("尊敬的 付斌 先生，您好："), "付斌");
check("尊敬的付斌先生：", extractStatementOwnerName("尊敬的付斌先生："), "付斌");
check("抬头式「付斌 先生」", extractStatementOwnerName("付斌 先生\n账单周期 2026-11"), "付斌");
check("尊敬的客户 不算姓名", extractStatementOwnerName("尊敬的客户，您好"), "");
check("持卡人：付斌", extractStatementOwnerName("持卡人：付斌"), "付斌");

// 账户名收敛
const ruralCredit = parseImportPaymentCardAccount("江苏农村商业银行信用卡(2058)", "付斌");
check("农村商业银行信用卡 机构名", ruralCredit?.institutionName, "农商银行");
check("农村商业银行信用卡 账户名", ruralCredit?.accountName, "付斌农商银行信用卡(2058)");
const ruralUnion = parseImportPaymentCardAccount("农村信用社信用卡(2058)", "付斌");
check("农村信用社信用卡 账户名", ruralUnion?.accountName, "付斌农商银行信用卡(2058)");
const icbcDebit = parseImportPaymentCardAccount("中国工商银行储蓄卡(5516)", "付斌");
check("非农商银行保留原文全称", icbcDebit?.accountName, "付斌中国工商银行储蓄卡(5516)");
// 「江苏农商联合银行」是独立法人机构，不能被并进「农商银行」
const ruralUnionBank = parseImportPaymentCardAccount("江苏农商联合银行储蓄卡(5516)", "墨斗鱼");
check("江苏农商联合银行 保留原文", ruralUnionBank?.accountName, "墨斗鱼江苏农商联合银行储蓄卡(5516)");

// 落回既有账户
const accounts = [
  {
    id: "acc-rural-credit",
    name: "付斌的农商银行信用卡(2058)",
    kind: "bank_credit",
    isActive: true,
    Institution: { name: "农商银行", shortName: "农商行" },
    AccountGroup: { name: "付斌" },
  },
  {
    id: "acc-icbc-debit",
    name: "付斌的中国工商银行储蓄卡(5516)",
    kind: "bank_debit",
    isActive: true,
    Institution: { name: "中国工商银行", shortName: "工行" },
    AccountGroup: { name: "付斌" },
  },
];
for (const text of [
  "付斌的农商银行信用卡(2058)",
  "付斌江苏农村商业银行信用卡(2058)",
  "付斌农商银行信用卡(2058)",
]) {
  check(`落回既有农商信用卡账户：${text}`, resolveImportAccountFromList(text, accounts)?.id, "acc-rural-credit");
}

if (failures > 0) {
  console.error(`\n${failures} 个用例失败`);
  process.exit(1);
}
console.log("\n全部通过");
