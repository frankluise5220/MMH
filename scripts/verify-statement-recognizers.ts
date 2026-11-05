// 账单识别器的分层判定 —— `npm run check:recognizer`。
//
// 背景：四个专用识别器（财智8 / 京东 / 支付宝 / 微信）原先都是「表头每一列都必须有」的
// 与条件。用户改过表头（删列、改列名、金额拆成「支出」「收入」两列）就整份降级到标准
// 模板；降级后「收/支」「支付方式」对不上标准别名，方向和账户会静默丢失——条数还在，
// 数据已经错了。
//
// 现在的分层：
//   0. 文件名先验（只排探测顺序 + 给提示，不代替表头判定）；
//   1. 表头打分（硬门槛 + 加分项，缺一列只减分）；
//   2. 账户名：昵称先清洗成「像人名」的部分，「墨斗鱼🙈🙉」不会拼成账户名；
//   3. 收支方向：收/支列 → 支出/收入哪列有值 → 文字线索 → 待确认。
//
// 断言：
// 1. 微信 2019 旧版（单列金额）命中 wechat，方向与账户正确；
// 2. 微信 2026 新版（支出/收入双列）命中 wechat；
// 3. 微信删「支付方式」列仍命中 wechat；
// 4. 微信「收/支」改名「收支方向」仍命中 wechat；
// 5. 微信删「收/支」列仍命中 wechat，方向退到文字线索；
// 6. 标准模板（交易时间/对方账户/收支大类/商品/支出/收入/账户）不被微信抢走；
// 7. 支付宝表头命中 alipay，缺「交易状态」仍命中；
// 8. 京东表头命中 jd，缺「收/付款方式」仍命中；
// 9. 文件名先验不改变判定：名字带「微信」但内容是标准模板 → standard。
//
// 纯离线：不连数据库、不读用户文件。

import assert from "node:assert/strict";

import {
  guessStatementTemplateHint,
  parseStatementSheetsStandard,
} from "../src/lib/statement/recognizer-pipeline";

type Sheet = { sheetName: string; rows: string[][] };

function parse(label: string, rows: string[][], sourceFileName = "") {
  const sheets: Sheet[] = [{ sheetName: "Sheet1", rows }];
  const out = parseStatementSheetsStandard(sheets, { sourceFileName, fundAware: true });
  console.log(`  · ${label}: template=${out.template} rows=${out.rows.length - 1}`);
  return out;
}

// 标准 11 列：日期|收支大类|流出|流入|金额|账户|对向账户|分类|收支机构|备注|第二备注
const COL = { date: 0, majorType: 1, outflow: 2, inflow: 3, amount: 4, account: 5, counterparty: 6 };

const WECHAT_2019: string[][] = [
  ["微信支付账单明细"],
  ["微信昵称：[ヅ~~墨斗鱼🙈🙉🙊]"],
  ["----------------------微信支付账单明细列表--------------------"],
  ["交易时间", "交易类型", "交易对方", "商品", "收/支", "金额(元)", "支付方式", "当前状态", "交易单号", "商户单号", "备注"],
  ["2019-01-02 12:00:00", "商户消费", "肯德基", "汉堡", "支出", "¥30.00", "/", "支付成功", "1", "2", ""],
  ["2019-01-03 09:00:00", "微信红包", "张三", "收到红包", "收入", "¥50.00", "/", "已存入零钱", "3", "4", ""],
];

const WECHAT_2026: string[][] = [
  ["微信支付账单明细"],
  ["微信昵称：[墨斗鱼]"],
  ["交易时间", "交易类型", "交易对方", "商品", "支出", "收入", "支付方式", "当前状态", "交易单号", "商户单号", "备注"],
  ["2026-01-02 12:00:00", "商户消费", "美团", "外卖", "¥20.00", "", "/", "支付成功", "1", "2", ""],
  ["2026-01-03 12:00:00", "转账", "李四", "收款", "", "¥100.00", "零钱", "已收款", "3", "4", ""],
];

const STANDARD_TEMPLATE: string[][] = [
  ["交易时间", "", "对方账户", "收支大类", "商品", "分类", "备注", "", "支出", "收入", "账户", "", ""],
  ["2026/11/03 16:10:47", "转账", "TK-胡忠璇", "支出", "转账备注:x", "", "备注x", "收入", "", "¥178.80", "墨斗鱼·微信·零钱", "/", "已存入零钱"],
  ["2026/11/02 11:23:49", "转账", "TK-叶天", "收入", "转账备注:y", "", "备注y", "支出", "¥104.00", "", "墨斗鱼·微信·零钱", "/", "已存入零钱"],
];

const ALIPAY: string[][] = [
  ["支付宝交易明细查询"],
  ["交易时间", "交易分类", "交易对方", "商品说明", "收/支", "金额", "交易状态", "交易号", "商户订单号", "备注"],
  ["2026-01-01 10:00:00", "餐饮美食", "星巴克", "咖啡", "支出", "33.00", "交易成功", "1", "2", ""],
];

const JD: string[][] = [
  ["京东交易明细"],
  ["交易时间", "商户名称", "交易说明", "收/支", "金额", "收/付款方式", "交易状态", "交易分类", "备注"],
  ["2026-01-01 08:00:00", "京东自营", "购买商品", "支出", "99.00", "招商银行", "交易成功", "购物", ""],
];

const dropColumn = (rows: string[][], headerName: string) => {
  const headerRow = rows.find((row) => row.includes(headerName));
  assert.ok(headerRow, `样本里找不到表头列 ${headerName}`);
  const columnIndex = headerRow.indexOf(headerName);
  return rows.map((row) => row.filter((_, index) => index !== columnIndex));
};

const renameColumn = (rows: string[][], from: string, to: string) =>
  rows.map((row) => (row.includes(from) ? row.map((cell) => (cell === from ? to : cell)) : row));

let assertionCount = 0;
const check = (label: string, fn: () => void) => {
  fn();
  assertionCount += 1;
  console.log(`PASS  ${label}`);
};

console.log("[1] 微信 2019 旧版（单列金额）");
check("命中 wechat，支出/收入方向正确", () => {
  const out = parse("wechat-2019", WECHAT_2019, "微信支付账单流水文件(20190101-20191231).xlsx");
  assert.equal(out.template, "wechat");
  assert.equal(out.rows.length - 1, 2);
  assert.equal(out.rows[1][COL.majorType], "支出");
  assert.ok(out.rows[1][COL.outflow]);
  assert.equal(out.rows[2][COL.majorType], "收入");
  assert.ok(out.rows[2][COL.inflow]);
});

check("昵称清洗：🙈🙉🙊 与装饰符不拼进账户名", () => {
  const out = parse("wechat-nickname", WECHAT_2019);
  assert.equal(out.rows[1][COL.account], "墨斗鱼微信零钱");
});

check("退款行（已全额退款）不清空账户，仍保留付款方式", () => {
  // 用户报的 2019-11-19 那笔：转账 ¥2,000 状态「已全额退款」，
  // 付款方式写着「零钱」，却因为标成待确认把账户清空，
  // 预览随即回退到发起导入的账户，记成了银行储蓄卡。
  const refund = WECHAT_2019.map((row, index) => (index === 4 ? [...row.slice(0, 7), "已全额退款", ...row.slice(8)] : row));
  const out = parse("wechat-refund", refund);
  assert.equal(out.template, "wechat");
  assert.equal(out.rows[1][COL.account], "墨斗鱼微信零钱");
  assert.match(String(out.rows[1][10] ?? ""), /已全额退款/);
});

console.log("[2] 微信 2026 新版（支出/收入双列）");
check("命中 wechat，双列金额各取一侧", () => {
  const out = parse("wechat-2026", WECHAT_2026, "微信支付账单流水文件(20260101-20261104).xlsx");
  assert.equal(out.template, "wechat");
  assert.equal(out.rows.length - 1, 2);
  assert.equal(out.rows[1][COL.majorType], "支出");
  assert.equal(out.rows[1][COL.amount], "20");
  assert.equal(out.rows[2][COL.majorType], "收入");
  assert.equal(out.rows[2][COL.amount], "100");
});

console.log("[3] 微信表头被用户改动");
check("删「支付方式」列仍命中 wechat", () => {
  const out = parse("wechat-no-payment", dropColumn(WECHAT_2019, "支付方式"));
  assert.equal(out.template, "wechat");
  assert.equal(out.rows.length - 1, 2);
});

check("「收/支」改名「收支方向」仍命中 wechat", () => {
  const out = parse("wechat-renamed-flow", renameColumn(WECHAT_2019, "收/支", "收支方向"));
  assert.equal(out.template, "wechat");
  assert.equal(out.rows[1][COL.majorType], "支出");
});

check("删「收/支」列仍命中 wechat，方向退到文字线索", () => {
  const out = parse("wechat-no-flow", dropColumn(WECHAT_2019, "收/支"));
  assert.equal(out.template, "wechat");
  assert.equal(out.rows[1][COL.majorType], "支出");
  assert.equal(out.rows[2][COL.majorType], "收入");
});

console.log("[4] 标准模板反被误吞的回归");
check("标准模板（含「支出/收入」双列）仍是 standard", () => {
  const out = parse("standard", STANDARD_TEMPLATE, "墨斗鱼.微信转账(20240101-20261103).xlsx");
  assert.equal(out.template, "standard");
  assert.equal(out.rows.length - 1, 2);
});

console.log("[5] 支付宝 / 京东");
check("支付宝表头命中 alipay", () => {
  const out = parse("alipay", ALIPAY, "支付宝交易明细(20260101-20260131).csv");
  assert.equal(out.template, "alipay");
  assert.equal(out.rows.length - 1, 1);
});

check("支付宝缺「交易状态」仍命中 alipay", () => {
  const out = parse("alipay-no-status", dropColumn(ALIPAY, "交易状态"));
  assert.equal(out.template, "alipay");
});

check("京东表头命中 jd", () => {
  const out = parse("jd", JD, "京东交易明细.csv");
  assert.equal(out.template, "jd");
  assert.equal(out.rows.length - 1, 1);
});

check("京东缺「收/付款方式」仍命中 jd", () => {
  const out = parse("jd-no-payment", dropColumn(JD, "收/付款方式"));
  assert.equal(out.template, "jd");
});

console.log("[6] 文件名先验");
check("文件名推断出模板提示", () => {
  assert.equal(guessStatementTemplateHint("墨斗鱼.微信支付账单流水文件(2026).xlsx"), "wechat");
  assert.equal(guessStatementTemplateHint("支付宝交易明细(2026).csv"), "alipay");
  assert.equal(guessStatementTemplateHint("京东交易明细.csv"), "jd");
  assert.equal(guessStatementTemplateHint("财智8导出.xlsx"), "caizhi");
  assert.equal(guessStatementTemplateHint("流水记录.xlsx"), null);
});

check("名字带「微信」但内容是标准模板，仍按表头判成 standard", () => {
  const out = parse("standard-with-wechat-name", STANDARD_TEMPLATE, "墨斗鱼.微信转账(20240101-20261103).xlsx");
  assert.equal(out.template, "standard");
  assert.equal(out.filenameHint, "wechat");
});

check("微信专属列全被删光时，文件名先验把微信提到前面", () => {
  const stripped = dropColumn(dropColumn(WECHAT_2019, "支付方式"), "当前状态");
  const withName = parse("wechat-stripped-named", stripped, "微信支付账单流水文件(2019).xlsx");
  assert.equal(withName.filenameHint, "wechat");
  assert.equal(withName.template, "wechat");
  // 同理，没有文件名线索时无法与支付宝表头区分，落到 alipay 是可接受的（字段仍能解析）。
  const anonymous = parse("wechat-stripped-anonymous", stripped);
  assert.equal(anonymous.filenameHint, undefined);
});

console.log(`\ncheck:recognizer ok（${assertionCount} 条断言）`);
