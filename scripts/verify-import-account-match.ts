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
  parseSettlementAccountName,
  parseSettlementCounterpartyFromRemark,
  parseSettlementCounterpartyFromText,
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
  Counterparty?: { name?: string | null; shortName?: string | null } | null;
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

/**
 * 2026-11-04 用户报告：备注「转账汇款李明月的往来款」的转账被识别成往来对象
 * 「钱手」——旧软件导出的往来款账户名字就叫「往来款」（挂在某人名下），
 * 宽松包含匹配让「李明月的往来款」落在了它身上。
 */
const settlementAccounts: Source[] = [
  // 钱手名下的泛名结算账户：名字只有「往来款」，靠挂的往来对象识别。
  { id: "payable-generic-qianshou", name: "往来款", kind: "settlement", AccountGroup: { name: "张四" }, Counterparty: { name: "钱手" } },
  // 明确写了对象名的结算账户。
  { id: "payable-limingyue", name: "李明月的往来款", kind: "settlement", AccountGroup: { name: "张四" }, Counterparty: { name: "李明月" } },
  { id: "receivable-wangwu", name: "王五的普通应收款", kind: "settlement", AccountGroup: { name: "张四" }, Counterparty: { name: "王五" } },
  // 「的应收款」「的应付款」同样是往来对象账户（2026-11-04 用户口径）。
  { id: "receivable-zhaoliu", name: "赵六的应收款", kind: "settlement", AccountGroup: { name: "张四" }, Counterparty: { name: "赵六" } },
  { id: "payable-sunqi", name: "孙七的应付款", kind: "settlement", AccountGroup: { name: "张四" }, Counterparty: { name: "孙七" } },
  // 真实账本里的重名场景：既有「加油卡的往来款」，也有挂在章啸名下的「加油卡」。
  { id: "payable-jiayouka", name: "加油卡的往来款", kind: "settlement", AccountGroup: { name: "张四" }, Counterparty: { name: "加油卡" } },
  { id: "settlement-jiayouka-zhangxiao", name: "加油卡", kind: "settlement", AccountGroup: { name: "张四" }, Counterparty: { name: "章啸" } },
  // 真实账本里的长对象名（6 字）：超过自由文本 5 字口径，但账本里确有这个账户。
  { id: "payable-lvyou", name: "旅游专用帐户的往来款", kind: "settlement", AccountGroup: { name: "张四" }, Counterparty: { name: "旅游专用帐户" } },
];
const settlementMatch = createImportAccountMatcher(settlementAccounts);

function expectSettlement(input: string, expectedId: string | null, note: string) {
  const result = settlementMatch(input);
  const actual = result.account?.id ?? null;
  if (actual === expectedId) {
    console.log(`PASS  "${input}" -> ${actual ?? "未匹配"}  (${note})`);
  } else {
    failed += 1;
    console.error(`FAIL  "${input}" -> ${actual ?? "未匹配"}，期望 ${expectedId ?? "未匹配"}  (${note})`);
  }
}

// 备注/列里写了谁就是谁，不能被泛名「往来款」账户吞掉。
expectSettlement("李明月的往来款", "payable-limingyue", "往来对象写进账户名时精确命中");
expectSettlement("钱手的往来款", "payable-generic-qianshou", "泛名「往来款」账户靠挂的往来对象识别");
expectSettlement("王五的往来款", "receivable-wangwu", "「普通应收款」变体同样按对象识别");
expectSettlement("加油卡的往来款", "payable-jiayouka", "名字写明对象优先于挂在别人名下的同名账户");
expectSettlement("加油卡", "settlement-jiayouka-zhangxiao", "不含「的往来款」的裸名不受新规则影响");
expectSettlement("赵六的应收款", "receivable-zhaoliu", "「的应收款」也是往来对象账户");
expectSettlement("孙七的应付款", "payable-sunqi", "「的应付款」也是往来对象账户");
expectSettlement("赵六的往来款", "receivable-zhaoliu", "同一对象名下的应收款账户可被「往来款」写法复用");
expectSettlement("周八的往来款", null, "账本里没有周八时不得静默落到别人的往来款账户");
expectSettlement("旅游专用帐户的普通应收款", "payable-lvyou", "长对象名靠与既有账户对象名等值互认");
expectSettlement("这是一笔转给李明月的往来款", null, "长前缀文本不得靠宽松包含落到别人的往来款账户");

// 统一解析口径：往来款/应收款/应付款（含「普通」变体、旧软件「往来帐」），对象名 ≤5 字。
function expectSettlementName(input: string, expected: string | null) {
  const actual = parseSettlementAccountName(input);
  if (actual === expected) {
    console.log(`PASS  "${input}" -> 对象 ${actual ?? "未解析"}  (命名口径)`);
  } else {
    failed += 1;
    console.error(`FAIL  "${input}" -> 对象 ${actual ?? "未解析"}，期望 ${expected ?? "未解析"}`);
  }
}
expectSettlementName("李四的应收款", "李四");
expectSettlementName("李四的应付款", "李四");
expectSettlementName("李四的普通应收款", "李四");
expectSettlementName("李四的普通应付款", "李四");
expectSettlementName("李四的往来帐", "李四");
expectSettlementName("优仕汽车的应收款", "优仕汽车");
// 账户名口径不限长：账本里确实有「旅游专用帐户的往来款」这种 6 字对象名。
expectSettlementName("旅游专用帐户的往来款", "旅游专用帐户");
// 自由文本口径限 5 字：更长的多半是整句描述，不能当对象名。
function expectTextName(input: string, expected: string | null) {
  const actual = parseSettlementCounterpartyFromText(input);
  if (actual === expected) {
    console.log(`PASS  文本"${input}" -> 对象 ${actual ?? "未解析"}  (5 字口径)`);
  } else {
    failed += 1;
    console.error(`FAIL  文本"${input}" -> 对象 ${actual ?? "未解析"}，期望 ${expected ?? "未解析"}`);
  }
}
expectTextName("李四的应收款", "李四");
expectTextName("优仕汽车的往来款", "优仕汽车");
expectTextName("超长对象名六个字的往来款", null);
// 备注要先剥掉动作词前缀，剩下的才是账户名。
function expectRemarkSettlement(remark: string, expected: string | null) {
  const actual = parseSettlementCounterpartyFromRemark(remark);
  if (actual === expected) {
    console.log(`PASS  备注「${remark}」 -> 对象 ${actual ?? "未解析"}`);
  } else {
    failed += 1;
    console.error(`FAIL  备注「${remark}」 -> 对象 ${actual ?? "未解析"}，期望 ${expected ?? "未解析"}`);
  }
}
expectRemarkSettlement("转账汇款李四的应收款", "李四");
expectRemarkSettlement("转出-李四的应付款", "李四");
expectRemarkSettlement("李四的往来款", "李四");
expectRemarkSettlement("超长对象名六个字的往来款", null);

// 未查询往来对象关系的调用方（Counterparty 为 undefined）保持旧口径，不能因为
// 拿不到对象信息就把原本能匹配的文本变成未匹配。
const legacySettlementMatch = createImportAccountMatcher([
  { id: "legacy-payable", name: "往来款", kind: "settlement", AccountGroup: { name: "张四" } },
] satisfies Source[]);
const legacyResult = legacySettlementMatch("赵六的往来款").account?.id ?? null;
if (legacyResult === "legacy-payable") {
  console.log("PASS  \"赵六的往来款\"（未加载往来对象） -> legacy-payable  (宽松口径保留)");
} else {
  failed += 1;
  console.error(`FAIL  "赵六的往来款"（未加载往来对象） -> ${legacyResult ?? "未匹配"}，期望 legacy-payable`);
}

if (failed > 0) {
  console.error(`\n${failed} 个用例失败`);
  process.exit(1);
}
console.log("\n全部通过");
