/**
 * 信用卡还款行的付款方守卫（2026-11-26 用户裁定）。
 *
 * 「自扣还款 / 自动还款 / 银联入账」说的是钱进了这张信用卡：信用卡不会给信用卡
 * 还款，本账户也不可能转账给自己。账单里不写付款方时，付款方必须落到同机构借记卡，
 * 挑不到就留空让用户点选——绝不能回填成这张卡自己，否则会记出一笔不存在的转账。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  accountReferenceKey,
  accountTail,
  isCreditCardRepaymentText,
  isSameAccountReference,
  pickSameInstitutionDebitCard,
} from "../src/lib/statement/credit-card-repayment-source";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  if (Object.is(actual, expected)) {
    console.log(`PASS  ${label}`);
    return;
  }
  failures += 1;
  console.log(`FAIL  ${label}  期望 ${String(expected)}，实际 ${String(actual)}`);
}

// ── 账户引用归一 ──
check("尾号：括号形式", accountTail("招商银行信用卡(1234)"), "1234");
check("尾号：掩码形式", accountTail("****2058"), "2058");
check("尾号：尾号字样", accountTail("尾号 5516"), "5516");
check("尾号：无尾号", accountTail("招商银行信用卡"), "");
check("归一键：尾号优先", accountReferenceKey("招商银行信用卡(尾号1234)"), "tail:1234");
check("同卡：括号 vs 尾号", isSameAccountReference("招商银行信用卡(尾号1234)", "尾号1234"), true);
check("同卡：账户名 vs 掩码", isSameAccountReference("付斌农商银行信用卡(2058)", "****2058"), true);
check("不同卡：信用卡 vs 储蓄卡", isSameAccountReference("招商银行信用卡", "招商银行储蓄卡"), false);
check("空值不算同卡", isSameAccountReference("", ""), false);

// ── 还款语义 ──
check("自扣还款是还款", isCreditCardRepaymentText("自扣还款"), true);
check("一键还款是还款", isCreditCardRepaymentText("口袋银行一键还款"), true);
check("银联入账是还款", isCreditCardRepaymentText("银联入账"), true);
check("还款券不是还款", isCreditCardRepaymentText("还款券 -2.58"), false);
check("空文本不是还款", isCreditCardRepaymentText("  "), false);

// ── 同机构借记卡 ──
const accounts = [
  { id: "credit", name: "付斌招商银行信用卡(1234)", kind: "bank_credit", Institution: { name: "招商银行" } },
  { id: "debit-cmb", name: "付斌招商银行储蓄卡(5678)", kind: "bank_debit", Institution: { name: "招商银行" } },
  { id: "debit-icbc", name: "付斌中国工商银行储蓄卡(5516)", kind: "bank_debit", Institution: { name: "中国工商银行" } },
  { id: "ewallet", name: "招商银行一卡通钱包", kind: "ewallet", Institution: { name: "招商银行" } },
];
check(
  "同机构借记卡唯一命中",
  pickSameInstitutionDebitCard(accounts, { institutionName: "招商银行", excludeIds: ["credit"] })?.id ?? null,
  "debit-cmb",
);
check(
  "机构简称也能对上",
  pickSameInstitutionDebitCard(accounts, { institutionName: "工商银行" })?.id ?? null,
  "debit-icbc",
);
const twoDebits = [
  ...accounts,
  { id: "debit-cmb2", name: "付斌招商银行储蓄卡(9999)", kind: "bank_debit", Institution: { name: "招商银行" } },
];
check(
  "同机构两张借记卡时不猜",
  pickSameInstitutionDebitCard(twoDebits, { institutionName: "招商银行", excludeIds: ["credit"] })?.id ?? null,
  null,
);
check(
  "没有发卡行时不猜",
  pickSameInstitutionDebitCard(accounts, { institutionName: "" })?.id ?? null,
  null,
);
check(
  "电子钱包不参与自动补全",
  pickSameInstitutionDebitCard([accounts[0], accounts[3]], { institutionName: "招商银行" })?.id ?? null,
  null,
);
check(
  "本卡被排除",
  pickSameInstitutionDebitCard(accounts, { institutionName: "招商银行", excludeIds: ["credit", "debit-cmb"] })?.id ?? null,
  null,
);
check(
  "停用账户不参与",
  pickSameInstitutionDebitCard(
    accounts.map((account) => (account.id === "debit-cmb" ? { ...account, isActive: false } : account)),
    { institutionName: "招商银行", excludeIds: ["credit"] },
  )?.id ?? null,
  null,
);

// ── 调用点守卫：规则必须在两个导入入口生效，不能被删掉 ──
const repoRoot = path.resolve(import.meta.dirname, "..");
const dialogSource = readFileSync(
  path.join(repoRoot, "src/components/StatementImportPreviewDialog.tsx"),
  "utf8",
);
check("邮件/明细预览有同账户守卫", /isSamePreviewAccountSide\(/.test(dialogSource), true);
check("邮件/明细预览会补同机构借记卡", /pickSameInstitutionDebitCard\(/.test(dialogSource), true);

const batchSource = readFileSync(
  path.join(repoRoot, "src/app/(sidebar)/batch-import/page.tsx"),
  "utf8",
);
check("批量导入有同账户守卫", /isSameAccountReference\(account, counter\)/.test(batchSource), true);

if (failures > 0) {
  console.error(`\n${failures} 个用例失败`);
  process.exit(1);
}
console.log("\n全部通过");
