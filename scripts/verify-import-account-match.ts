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
  createImportAccountIdentityConflictChecker,
  createImportAccountMatcher,
  parseImportOwnedMoneyAccountCandidate,
  parseImportPaymentCardAccount,
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
  AccountGroup?: {
    name?: string | null;
    Institution?: { name?: string | null; shortName?: string | null } | null;
  } | null;
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

// 2026-11-05 用户报告：微信「支付方式」写「招商银行储蓄卡(9447)」时，
// 不能落到同一银行下另一张借记卡（账本里那张叫「一卡通」）。
// 「一卡通」是借记卡的同义展开，候选键里也有「招商银行储蓄卡」，
// 会抢走「招商银行储蓄卡(9447)」的精确匹配。
const cardAccounts: Source[] = [
  { id: "cmb-9447", name: "9447", kind: "bank_debit", Institution: { name: "招商银行", shortName: "招行" }, AccountGroup: { name: "墨斗鱼" } },
  { id: "cmb-7457", name: "7457", kind: "bank_debit", Institution: { name: "招商银行", shortName: "招行" }, AccountGroup: { name: "墨斗鱼" } },
  { id: "cmb-yikatong", name: "一卡通", kind: "bank_debit", Institution: { name: "招商银行", shortName: "招行" }, AccountGroup: { name: "墨斗鱼" } },
  { id: "jsrcb-5516", name: "5516", kind: "bank_debit", Institution: { name: "江苏农商联合银行" }, AccountGroup: { name: "墨斗鱼" } },
];
const cardMatch = createImportAccountMatcher(cardAccounts, { ownerName: "墨斗鱼" });

function expectCard(
  query: string,
  owner: string,
  expectedName: string,
  expectedId: string | null,
  note: string,
) {
  const parsed = parseImportPaymentCardAccount(query, owner);
  const actualName = parsed?.accountName ?? "(未解析)";
  const actualId = parsed ? cardMatch(parsed.accountName).account?.id ?? null : null;
  if (actualName === expectedName && actualId === expectedId) {
    console.log(`PASS  ${note}：${query} -> ${actualName} -> ${actualId ?? "未匹配"}`);
  } else {
    failed += 1;
    console.error(
      `FAIL  ${note}：${query} -> ${actualName} -> ${actualId ?? "未匹配"}，期望 ${expectedName} -> ${expectedId ?? "未匹配"}`,
    );
  }
}

expectCard("招商银行储蓄卡(9447)", "墨斗鱼", "墨斗鱼招商银行储蓄卡(9447)", "cmb-9447", "招行储蓄卡带尾号不落到一卡通");
expectCard("江苏农商联合银行储蓄卡(5516)", "墨斗鱼", "墨斗鱼江苏农商联合银行储蓄卡(5516)", "jsrcb-5516", "机构名保留原文全称");
expectCard("亲属卡(老四)", "墨斗鱼", "(未解析)", null, "亲属卡不是银行卡");

// 只给机构 + 尾号（没有卡类型词）也要能落到那张卡。
{
  const actualId = cardMatch("墨斗鱼招商银行9447").account?.id ?? null;
  if (actualId === "cmb-9447") {
    console.log("PASS  只写机构 + 尾号 -> cmb-9447");
  } else {
    failed += 1;
    console.error(`FAIL  只写机构 + 尾号 -> ${actualId ?? "未匹配"}，期望 cmb-9447`);
  }
}

{
  const ownerGroup = (name: string, shortName: string) => ({ name, Institution: { name, shortName } });
  const ownedAccounts: Source[] = [
    {
      id: "cmb-9447",
      name: "9447",
      kind: "bank_debit",
      Institution: { name: "招商银行" },
      AccountGroup: ownerGroup("墨斗鱼", "老三"),
    },
    {
      id: "cmb-7457",
      name: "7457",
      kind: "bank_debit",
      Institution: { name: "招商银行" },
      AccountGroup: ownerGroup("李四", "老四"),
    },
    { id: "coin-a", name: "零钱", kind: "ewallet", AccountGroup: ownerGroup("墨斗鱼", "老三") },
    { id: "coin-b", name: "零钱", kind: "ewallet", AccountGroup: ownerGroup("李四", "老四") },
  ];
  const ownedMatch = createImportAccountMatcher(ownedAccounts, { ownerName: null });
  const ownerCases: Array<[string, string, string]> = [
    ["墨斗鱼·招商银行储蓄卡(9447)", "cmb-9447", "正名收窄"],
    ["老三·招商银行储蓄卡(9447)", "cmb-9447", "简称与正名等价"],
    ["老三·零钱", "coin-a", "简称收窄到同名的零钱账户"],
    ["老四·零钱", "coin-b", "另一个简称不串到别人名下"],
  ];
  for (const [query, expectedId, note] of ownerCases) {
    const actualId = ownedMatch(query).account?.id ?? null;
    if (actualId === expectedId) {
      console.log(`PASS  ${note}：${query} -> ${actualId}`);
    } else {
      failed += 1;
      console.error(`FAIL  ${note}：${query} -> ${actualId ?? "未匹配"}，期望 ${expectedId}`);
    }
  }

  // 简称要能被「所有人 + 账户」解析器认出来（新建账户走这条路）。
  const parsedByShort = parseImportOwnedMoneyAccountCandidate("老三的招商银行储蓄卡(9447)", [
    "墨斗鱼",
    "老三",
  ]);
  if (parsedByShort?.ownerName === "老三") {
    console.log(`PASS  简称作为所有人前缀被解析：owner=${parsedByShort.ownerName}`);
  } else {
    failed += 1;
    console.error(`FAIL  简称作为所有人前缀被解析：${parsedByShort?.ownerName ?? "未解析"}`);
  }
}

// 「所有人 + 支付渠道」要能建成电子钱包账户。
// 2026-11-06 用户：勾选「创建所有人的账户」后，「墨斗鱼的云闪付」在导入预览里仍是「缺对向账户」——
// 渠道名既不是账户类型词也没有卡号尾号，旧口径判不出账户种类，整条文本不可创建。
const paymentChannelCases: Array<[string, string]> = [
  ["墨斗鱼的云闪付", "云闪付"],
  ["墨斗鱼的微信", "微信"],
  ["墨斗鱼的微信支付", "微信"],
  ["墨斗鱼的支付宝", "支付宝"],
];
for (const [raw, expectedName] of paymentChannelCases) {
  const parsedChannel = parseImportOwnedMoneyAccountCandidate(raw, ["墨斗鱼", "老三"]);
  if (
    parsedChannel?.kind === "ewallet" &&
    parsedChannel.accountName === expectedName &&
    parsedChannel.institutionName === expectedName &&
    parsedChannel.ownerName === "墨斗鱼"
  ) {
    console.log(`PASS  支付渠道建电子钱包：${raw} -> ${parsedChannel.accountName}/${parsedChannel.kind}/${parsedChannel.ownerName}`);
  } else {
    failed += 1;
    console.error(
      `FAIL  支付渠道建电子钱包：${raw} -> ${
        parsedChannel
          ? `${parsedChannel.accountName}/${parsedChannel.kind}/${parsedChannel.ownerName}/${parsedChannel.institutionName ?? "-"}`
          : "未解析"
      }，期望 ${expectedName}/ewallet/墨斗鱼/${expectedName}`,
    );
  }
}
// 已有类型词或投资产品词时，账户名不能被换成渠道名。
const channelTypeWord = parseImportOwnedMoneyAccountCandidate("墨斗鱼的京东小金库", ["墨斗鱼"]);
if (channelTypeWord?.accountName === "小金库") {
  console.log(`PASS  类型词优先于渠道名：墨斗鱼的京东小金库 -> ${channelTypeWord.accountName}`);
} else {
  failed += 1;
  console.error(`FAIL  类型词优先于渠道名：墨斗鱼的京东小金库 -> ${channelTypeWord?.accountName ?? "未解析"}`);
}
const channelInvestWord = parseImportOwnedMoneyAccountCandidate("墨支付宝基金", ["墨斗鱼", "墨"]);
if (channelInvestWord?.kind === "investment" && channelInvestWord.accountName === "基金") {
  console.log(`PASS  投资产品词优先于渠道名：墨支付宝基金 -> ${channelInvestWord.accountName}/${channelInvestWord.kind}`);
} else {
  failed += 1;
  console.error(
    `FAIL  投资产品词优先于渠道名：墨支付宝基金 -> ${channelInvestWord ? `${channelInvestWord.accountName}/${channelInvestWord.kind}` : "未解析"}，期望 基金/investment`,
  );
}

/**
 * 回归：账本里只有一个所有人名下的「余额宝」时，导入另一个所有人的
 * 「XX·支付宝·余额宝」会被「全库唯一」兜底静默落到别人的账户，
 * 之后还可能串到同机构下的基金账户。
 * 修复：所有唯一候选兜底按文本/上下文的所有人收窄，冲突检查补归属维度。
 */
const yuebaoAccounts: Source[] = [
  { id: "yeb-lisi", name: "余额宝", kind: "ewallet", Institution: { name: "支付宝" }, AccountGroup: { name: "李四" } },
  { id: "fund-zhangsan", name: "支付宝基金", kind: "investment", Institution: { name: "支付宝" }, AccountGroup: { name: "张三" } },
  { id: "yeb-zhangsan", name: "余额宝", kind: "ewallet", Institution: { name: "支付宝" }, AccountGroup: { name: "张三" } },
];
const onlyLisi = createImportAccountMatcher(yuebaoAccounts.filter((account) => account.id !== "yeb-zhangsan"));
const onlyLisiWithOwner = createImportAccountMatcher(
  yuebaoAccounts.filter((account) => account.id !== "yeb-zhangsan"),
  { ownerName: "张三" },
);
const bothYuebao = createImportAccountMatcher(yuebaoAccounts);

function expectNoAccount(
  matcher: (input: string) => { account: { id: string } | null },
  input: string,
  note: string,
) {
  const result = matcher(input);
  if (!result.account) {
    console.log(`PASS  "${input}" -> 未匹配  (${note})`);
  } else {
    failed += 1;
    console.error(`FAIL  "${input}" -> ${result.account.id}，期望未匹配  (${note})`);
  }
}

// 账本里只有另一个人的余额宝时，写了所有人的文本不许猜到它。
expectNoAccount(onlyLisi, "张三·支付宝·余额宝·电子钱包", "跨归属不得静默落到唯一余额宝账户");
expectNoAccount(onlyLisi, "张三·支付宝·余额宝", "简写同样按文本所有人收窄");
expectNoAccount(onlyLisiWithOwner, "张三·支付宝·余额宝·电子钱包", "导入来源已确定所有人时也不得串归属");
expectNoAccount(onlyLisiWithOwner, "余额宝", "上下文所有人优先于全库唯一兜底");

// 两个归属都有余额宝时，按文本所有人精确区分；裸名不猜。
expectAccountWith(bothYuebao, "张三·支付宝·余额宝·电子钱包", "yeb-zhangsan", "文本所有人命中同名账户");
expectAccountWith(bothYuebao, "李四·支付宝·余额宝", "yeb-lisi", "另一个所有人命中自己的账户");
expectNoAccount(bothYuebao, "余额宝", "两个同名账户：裸名保留歧义，不静默猜");

function expectAccountWith(
  matcher: (input: string) => { account: { id: string } | null },
  input: string,
  expectedId: string,
  note: string,
) {
  const result = matcher(input);
  if (result.account?.id === expectedId) {
    console.log(`PASS  "${input}" -> ${expectedId}  (${note})`);
  } else {
    failed += 1;
    console.error(`FAIL  "${input}" -> ${result.account?.id ?? "未匹配"}，期望 ${expectedId}  (${note})`);
  }
}

const yebConflict = createImportAccountIdentityConflictChecker(yuebaoAccounts);
function expectConflictKind(selectedId: string, original: string, expected: string | null, note: string) {
  const selected = yuebaoAccounts.find((account) => account.id === selectedId);
  const actual = yebConflict(selected, original)?.kind ?? null;
  if (actual === expected) {
    console.log(`PASS  冲突检查 ${selectedId} / "${original}" -> ${actual ?? "无冲突"}  (${note})`);
  } else {
    failed += 1;
    console.error(`FAIL  冲突检查 ${selectedId} / "${original}" -> ${actual ?? "无冲突"}，期望 ${expected ?? "无冲突"}  (${note})`);
  }
}

expectConflictKind("yeb-lisi", "张三·支付宝·余额宝·电子钱包", "owner", "跨归属选中必须报归属冲突");
expectConflictKind("fund-zhangsan", "张三·支付宝·余额宝·电子钱包", "account", "原文能匹配到本人余额宝时选基金账户仍报账户冲突");
expectConflictKind("yeb-zhangsan", "张三·支付宝·余额宝·电子钱包", null, "归属正确的账户无冲突");
expectConflictKind("yeb-lisi", "余额宝", null, "原文没写所有人时不误报归属冲突");

if (failed > 0) {
  console.error(`\n${failed} 个用例失败`);
  process.exit(1);
}
console.log("\n全部通过");
