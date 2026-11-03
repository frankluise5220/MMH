/**
 * 导入账户匹配（createImportAccountMatcher）回归守卫。
 *
 * 背景（2026-11-03 用户报告）：账单里账户文本写成 ASCII 句点分隔的
 * 「墨斗鱼.江苏.信用卡」，归一化键与所有人前缀正则只认 ·/-/_ 等分隔符、
 * 不认句点，导致精确候选键「墨斗鱼江苏信用卡」匹配失败，落到宽松包含
 * 匹配后裸名「信用卡」命中全部 9 张同名信用卡，提示“匹配到9个账户”。
 * 修复后句点与「·」同待遇。
 *
 * 运行：npx tsx scripts/verify-import-account-match.ts
 */
import {
  createImportAccountMatcher,
  type ImportAccountKind,
} from "../src/lib/account-import-match";

type Source = {
  id: string;
  name: string;
  kind?: ImportAccountKind | null;
  numberMasked?: string | null;
  Institution?: { name?: string | null; shortName?: string | null } | null;
  AccountGroup?: { name?: string | null } | null;
  AccountAlias?: Array<{ alias: string }> | null;
};

/** 复现用户账本：9 张同名「信用卡」分属不同机构/所有人，机构「江苏」不在内置银行别名表里。 */
const accounts: Source[] = [
  { id: "cc-jiangsu", name: "信用卡", kind: "bank_credit", Institution: { name: "江苏" }, AccountGroup: { name: "墨斗鱼" } },
  { id: "cc-cmb", name: "信用卡", kind: "bank_credit", Institution: { name: "招商银行", shortName: "招行" }, AccountGroup: { name: "墨斗鱼" } },
  { id: "cc-icbc", name: "信用卡", kind: "bank_credit", Institution: { name: "工商银行" }, AccountGroup: { name: "墨斗鱼" } },
  { id: "cc-ccb", name: "信用卡", kind: "bank_credit", Institution: { name: "建设银行" }, AccountGroup: { name: "墨斗鱼" } },
  { id: "cc-abc", name: "信用卡", kind: "bank_credit", Institution: { name: "农业银行" }, AccountGroup: { name: "墨斗鱼" } },
  { id: "cc-bocom", name: "信用卡", kind: "bank_credit", Institution: { name: "交通银行" }, AccountGroup: { name: "墨斗鱼" } },
  { id: "cc-cmbc", name: "信用卡", kind: "bank_credit", Institution: { name: "民生银行" }, AccountGroup: { name: "张四" } },
  { id: "cc-citic", name: "信用卡", kind: "bank_credit", Institution: { name: "中信银行" }, AccountGroup: { name: "张四" } },
  { id: "cc-spf", name: "信用卡", kind: "bank_credit", Institution: { name: "浦发银行" }, AccountGroup: { name: "张四" } },
  { id: "debit-cmb", name: "储蓄卡", kind: "bank_debit", Institution: { name: "招商银行", shortName: "招行" }, AccountGroup: { name: "墨斗鱼" } },
];

const match = createImportAccountMatcher(accounts);

let failed = 0;
function expectAccount(input: string, expectedId: string, note: string) {
  const result = match(input);
  if (result.account?.id === expectedId) {
    console.log(`PASS  "${input}" -> ${expectedId}  (${note})`);
  } else {
    failed += 1;
    console.error(
      `FAIL  "${input}" -> ${result.account?.id ?? `歧义${result.ambiguousAccounts.length}个`}，期望 ${expectedId}  (${note})`,
    );
  }
}

function expectAmbiguous(input: string, minCount: number, note: string) {
  const result = match(input);
  if (!result.account && result.ambiguousAccounts.length >= minCount) {
    console.log(`PASS  "${input}" -> 保留 ${result.ambiguousAccounts.length} 个歧义候选  (${note})`);
  } else {
    failed += 1;
    console.error(
      `FAIL  "${input}" -> ${result.account?.id ?? `${result.ambiguousAccounts.length} 个歧义`}，期望 ≥${minCount} 个歧义候选  (${note})`,
    );
  }
}

// 本次 bug：ASCII 句点分隔的「所有人.机构.类型」必须精确命中唯一账户。
expectAccount("墨斗鱼.江苏.信用卡", "cc-jiangsu", "句点分隔：机构不在内置银行别名表也能精确命中");
// 「·」分隔原本就可用，修复句点后不得回归。
expectAccount("墨斗鱼·江苏·信用卡", "cc-jiangsu", "中点分隔保持原行为");
expectAccount("墨斗鱼.招商银行.信用卡", "cc-cmb", "句点分隔泛化：已知机构同样命中");
// 既往修复（af069194）：「机构+类型」在机构下唯一时命中该卡，而非全部同名卡。
expectAccount("招商银行信用卡", "cc-cmb", "机构+类型唯一命中");
expectAccount("张四的民生银行信用卡", "cc-cmbc", "所有人前缀必须被尊重");
// 裸类型词仍然不猜：保留歧义交给用户手动选。
expectAmbiguous("信用卡", 9, "裸「信用卡」不得静默猜测");

if (failed > 0) {
  console.error(`\n${failed} 个用例失败`);
  process.exit(1);
}
console.log("\n全部通过");
