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
// 9. 文件名先验不改变判定：名字带「微信」但内容是标准模板 → standard；
// 10. 财智8 账户名不带「财智」软件名前缀（「财智.章啸的往来款_2026-11-17.xls」）；
// 11. 财智8「样板行」列标记为是的行（连整张样板 sheet）一律不导入。
//
// 纯离线：不连数据库、不读用户文件。

import assert from "node:assert/strict";

import {
  guessStatementTemplateHint,
  parseStatementSheetsStandard,
} from "../src/lib/statement/recognizer-pipeline";
import {
  findTemplateSampleColumnIndex,
  isTemplateSampleRowValue,
  stripTemplateRows,
  TEMPLATE_GUIDE_TITLE_HINTS,
} from "../src/lib/import-template-sample";
import { parseEmlSheets, parseHtmlSheets } from "../src/lib/statement/eml-sheet-reader";
import { readStatementSheetRows } from "../src/lib/statement/statement-sheet-reader";
import { buildStatementTableText, classifyPdfParseError } from "../src/lib/mail/pdf";
import { installPdfCanvasShim } from "../src/lib/mail/pdf-canvas-shim";
import { STATEMENT_IMPORT_FIELD_HEADERS } from "../src/lib/statement/header-catalog";
import { parseStatementTemplateRows } from "../src/lib/statement/excel-preview";

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
  ["2026/11/03 16:10:47", "转账", "TK-胡忠宪", "支出", "转账备注:x", "", "备注x", "收入", "", "¥178.80", "墨斗鱼·微信·零钱", "/", "已存入零钱"],
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

check("退款行（已全额退款）翻成收入，账户仍保留付款方式", () => {
  // 用户报的 2019-11-19 那笔：转账 ¥2,000 状态「已全额退款」。
  // 微信旧版不会另起一条收入，只把原支出行的状态改成「已全额退款」，
  // 钱当天已退回零钱，所以这一笔必须记成收入（金额仍是正数）。
  // 同一笔重转的 2019-11-20 那行状态是「对方已收钱」，仍是支出。
  const refund = WECHAT_2019.map((row, index) => (index === 4 ? [...row.slice(0, 7), "已全额退款", ...row.slice(8)] : row));
  const out = parse("wechat-refund", refund);
  assert.equal(out.template, "wechat");
  assert.equal(out.rows[1][COL.majorType], "收入");
  assert.equal(out.rows[1][COL.outflow], "");
  assert.equal(out.rows[1][COL.inflow], "30");
  assert.equal(out.rows[1][COL.account], "墨斗鱼微信零钱");
  const remark = String(out.rows[1][10] ?? "");
  assert.match(remark, /状态:已全额退款/);
  assert.match(remark, /原收支:支出/);
  // 非退款行不被翻转：样本第二条（微信红包 收入 ¥50）保持收入且不带「原收支」。
  assert.equal(out.rows[2][COL.majorType], "收入");
  assert.doesNotMatch(String(out.rows[2][10] ?? ""), /原收支/);
});

check("银行卡付款方式解析成 机构+卡类型+尾号", () => {
  // 微信 2019 版「支付方式」写「招商银行储蓄卡(9447)」：
  // 账户名必须补全成 所有人+机构+卡类型+尾号，交给匹配器按尾号精确落账。
  const rows = WECHAT_2019.map((row, index) => (index === 4 ? [...row.slice(0, 6), "招商银行储蓄卡(9447)", ...row.slice(7)] : row));
  const out = parse("wechat-card", rows);
  assert.equal(out.template, "wechat");
  assert.equal(out.rows[1][COL.account], "墨斗鱼招商银行储蓄卡(9447)");
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

console.log("[7] 财智8 账户明细");

// 财智8 归一化后的列序（比标准模板多一列「入账日期」，位置与 COL 不同）。
const CAIZHI_COL = { date: 0, majorType: 2, outflow: 3, inflow: 4, account: 5, counterparty: 6, category: 7 };

const CAIZHI: string[][] = [
  ["日期", "流入", "流出", "活动类型", "标签", "余额", "备注"],
  ["2026-01-02", "100", "", "转入|付斌·招行·信用卡·8448", "", "100", ""],
  ["2026-01-03", "", "30", "服装及饰品", "", "70", "运动裤"],
];

// 财智导出的工作簿里会混进「样板行」：多一列「样板行」，标记「是」的行是账本里的
// 样板/示例数据（不是本账户流水），连整张 sheet 都可能是样板 sheet。
const CAIZHI_WITH_SAMPLE: string[][] = [
  ["日期", "流入", "流出", "活动类型", "标签", "余额", "备注", "样板行"],
  ["2026-01-02", "", "300", "转出|付斌的招行3833", "", "14825.83", "", "是"],
  ["2026-01-05", "", "10", "零食", "", "478.5", "", ""],
  ["2026-01-06", "50", "", "转入|付斌·交行·2479", "", "528.5", "", "否"],
];

check("财智表头命中 caizhi，账户名取文件名", () => {
  const out = parse("caizhi", CAIZHI, "付斌的招行2758_明细_2026-09-13.xls");
  assert.equal(out.template, "caizhi");
  assert.equal(out.rows.length - 1, 2);
  assert.equal(out.rows[1][CAIZHI_COL.account], "付斌的招行2758");
  assert.equal(out.rows[1][CAIZHI_COL.majorType], "转账");
  assert.equal(out.rows[1][CAIZHI_COL.counterparty], "付斌·招行·信用卡·8448");
  assert.equal(out.rows[2][CAIZHI_COL.majorType], "支出");
});

check("账户名不带「财智」软件名前缀（前缀式 / 中缀式）", () => {
  const prefixed = parse("caizhi-name-prefix", CAIZHI, "财智.章啸的往来款_2026-11-17.xls");
  assert.equal(prefixed.rows[1][CAIZHI_COL.account], "章啸的往来款");
  const infixed = parse("caizhi-name-infix", CAIZHI, "姜慧的招行一卡通_财智_2026-09-03.xls");
  assert.equal(infixed.rows[1][CAIZHI_COL.account], "姜慧的招行一卡通");
});

check("「样板行」列标记为是的行不导入", () => {
  const out = parse("caizhi-sample", CAIZHI_WITH_SAMPLE, "付斌的苏宁、京东_明细_2026-11-17.xls");
  assert.equal(out.template, "caizhi");
  // 两行正常数据（空 / 「否」），样板行被剔除。
  assert.equal(out.rows.length - 1, 2);
  assert.equal(out.rows[1][CAIZHI_COL.outflow], "10");
  assert.equal(out.rows[2][CAIZHI_COL.inflow], "50");
  assert.equal(out.rows[1][CAIZHI_COL.account], "付斌的苏宁、京东");
});

check("整张 sheet 都是样板行时该 sheet 一条不取", () => {
  const sheets: Sheet[] = [
    { sheetName: "明细", rows: CAIZHI },
    { sheetName: "Sheet1", rows: CAIZHI_WITH_SAMPLE.map((row, index) => (index === 0 ? row : [...row.slice(0, 7), "是"])) },
  ];
  const out = parseStatementSheetsStandard(sheets, { sourceFileName: "计划帐户(姜)_明细_2026-09-02.xls", fundAware: true });
  assert.equal(out.template, "caizhi");
  assert.equal(out.rows.length - 1, 2);
  assert.equal(out.rows[1][CAIZHI_COL.account], "计划帐户(姜)");
});

check("stripTemplateRows 同时剔除样板行与底部字段说明区", () => {
  const headers = ["日期", "收支", "金额", "样板行"];
  const dataRows = [
    ["2026-06-08", "支出", "32.50", "是"],
    ["2026-06-09", "收入", "1.28", ""],
    ["2026-06-10", "支出", "9.90", "yes"],
    ["本页字段说明（示例文案）", "", "", ""],
    ["日期", "必填", "YYYY-MM-DD", ""],
  ];
  const kept = stripTemplateRows(dataRows, headers, TEMPLATE_GUIDE_TITLE_HINTS);
  assert.equal(kept.length, 1);
  assert.equal(kept[0][0], "2026-06-09");
});

check("marker column is localized (Sample Row / サンプル行)", () => {
  assert.equal(findTemplateSampleColumnIndex(["Date", "Sample Row"]), 1);
  assert.equal(findTemplateSampleColumnIndex(["日付", "サンプル行"]), 1);
  assert.equal(isTemplateSampleRowValue("はい"), true);
  assert.equal(isTemplateSampleRowValue("否"), false);
});

console.log("[8] 中石化加油卡电子钱包账单（表头与财智同形，靠内容判据区分）");

// 与用户样本一致：日期|流入|流出|活动类型|标签|余额|备注。
const SINOPEC: string[][] = [
  ["日期", "流入", "流出", "活动类型", "标签", "余额", "备注"],
  ["2017-06-01", "3406.08", "", "余额调整", "", "3406.08", ""],
  ["2017-06-15", "", "300", "YZ汽油", "", "3106.08", ""],
  ["2017-08-11", "", "295.9", "YZ汽油", "", "2810.18", "79000"],
  ["2017-10-20", "400", "", "转入|02/07/交行2479/03", "", "3210.18", ""],
  ["2020-06-20", "40", "", "转入|中石油加油卡", "", "3250.18", ""],
];

check("中石化账单命中 sinopec（即使文件名带 _明细_日期 也不被财智抢走）", () => {
  const out = parse("sinopec", SINOPEC, "中石化加油卡_明细_2026-11-22.xls");
  assert.equal(out.template, "sinopec");
  assert.equal(out.filenameHint, "sinopec");
  // 余额调整被剔除，剩 4 条流水。
  assert.equal(out.rows.length - 1, 4);
});

check("账户固定为钱包「中石化加油卡」，不依赖文件名", () => {
  const named = parse("sinopec-named", SINOPEC, "中石化加油卡_明细_2026-11-22.xls");
  const anonymous = parse("sinopec-anonymous", SINOPEC, "流水.xls");
  for (const out of [named, anonymous]) {
    assert.equal(out.template, "sinopec");
    for (const row of out.rows.slice(1)) assert.equal(row[CAIZHI_COL.account], "中石化加油卡");
  }
});

check("YZ汽油 → 支出 + 分类「加油」+ 机构「中国石化」，里程进备注", () => {
  const out = parse("sinopec-fuel", SINOPEC, "中石化加油卡.xls");
  const fuel = out.rows[1];
  assert.equal(fuel[CAIZHI_COL.majorType], "支出");
  assert.equal(fuel[CAIZHI_COL.outflow], "300");
  assert.equal(fuel[CAIZHI_COL.category], "加油");
  assert.equal(fuel[8], "中国石化");
  const withMileage = out.rows[2];
  assert.equal(withMileage[10], "79000");
});

check("转入|xxx → 转账 + 对向账户为充值来源", () => {
  const out = parse("sinopec-topup", SINOPEC, "中石化加油卡.xls");
  const topup = out.rows[3];
  assert.equal(topup[CAIZHI_COL.majorType], "转账");
  assert.equal(topup[CAIZHI_COL.inflow], "400");
  assert.equal(topup[CAIZHI_COL.counterparty], "02/07/交行2479/03");
  assert.equal(topup[CAIZHI_COL.category], "充值");
});

check("余额调整行进入余额校准通道，不作为流水", () => {
  const out = parse("sinopec-balance", SINOPEC, "中石化加油卡.xls");
  assert.ok(out.caizhiBalanceAdjustRows, "应有余额校准行");
  assert.equal(out.caizhiBalanceAdjustRows!.length, 1);
  assert.equal(out.caizhiBalanceAdjustRows![0].date, "2017-06-01");
  assert.equal(out.caizhiBalanceAdjustRows![0].targetBalance, 3406.08);
});

check("普通财智文件（无中石化活动类型）仍判 caizhi，不被吞", () => {
  const out = parse("caizhi-not-sinopec", CAIZHI, "付斌的招行2758_明细_2026-09-13.xls");
  assert.equal(out.template, "caizhi");
  assert.equal(out.rows[1][CAIZHI_COL.account], "付斌的招行2758");
});

// eml 账单的「交易信息」11 列与「付费信息」5 列（用户 2026-11-22 口径：原表字段全进备注）。
const SINOPEC_EMAIL_TRADE: string[][] = [
  ["卡号", "持卡人", "交易时间", "交易类型", "油品", "数量(升)", "单价(元)", "金额(元)", "奖励分值", "余额(元)", "地点"],
  ["1000113200006508614", "付斌", "2024-01-02 07:30:04", "消费", "95号汽油", "42.56", "7.99", "340.0", "0.0", "4360.0", "扬州邗城站"],
];
const SINOPEC_EMAIL_PAYMENT: string[][] = [
  ["序号", "付费时间", "付费地点", "收款方式", "充值金额(元)"],
  ["1", "2024-01-02 07:32:43", "易捷红包充值网点1", "null", "305.54"],
  ["2", "2024-01-10 12:16:51", "江苏支付宝第一商户", "支付宝", "110.0"],
];

check("eml 交易信息表：命中 sinopec，升数/单价/地点/油品全部写进备注", () => {
  const out = parse("sinopec-email-trade", SINOPEC_EMAIL_TRADE, "中石化加油卡_账单导入_2024-01.xlsx");
  assert.equal(out.template, "sinopec");
  assert.equal(out.rows.length - 1, 1);
  const row = out.rows[1];
  assert.equal(row[CAIZHI_COL.majorType], "支出");
  assert.equal(row[CAIZHI_COL.outflow], "340");
  assert.equal(row[CAIZHI_COL.account], "中石化加油卡");
  assert.equal(row[CAIZHI_COL.category], "加油");
  assert.equal(row[8], "中国石化");
  const remark = row[10];
  for (const field of ["油品:95号汽油", "数量(升):42.56", "单价(元):7.99", "地点:扬州邗城站", "余额(元):4360.0"]) {
    assert.ok(remark.includes(field), `备注应含 ${field}，实际 ${remark}`);
  }
  // 账户统一属性（卡号/持卡人/交易类型）不进备注。
  for (const field of ["持卡人", "卡号", "交易类型"]) {
    assert.ok(!remark.includes(field), `备注不应含账户属性 ${field}，实际 ${remark}`);
  }
});

check("eml 付费信息表：充值按收入落钱包，地点/收款方式进备注", () => {
  const sheets: Sheet[] = [
    { sheetName: "交易信息", rows: SINOPEC_EMAIL_TRADE },
    { sheetName: "付费信息", rows: SINOPEC_EMAIL_PAYMENT },
  ];
  const out = parseStatementSheetsStandard(sheets, { sourceFileName: "中石化加油卡_账单导入_2024-01.xlsx", fundAware: true });
  assert.equal(out.template, "sinopec");
  const topups = out.rows.slice(1).filter((r) => r[CAIZHI_COL.majorType] === "收入");
  assert.equal(topups.length, 2);
  assert.equal(topups[0][CAIZHI_COL.inflow], "305.54");
  assert.ok(topups[0][10].includes("地点:易捷红包充值网点1"));
  assert.ok(topups[1][10].includes("收款方式:支付宝"));
});

(async () => {
console.log("[9] .eml 邮件账单直接导入（正文 HTML 表格 → sheet 行）");

const EML_BODY = [
  "From: jykwt-support@sinopec.com",
  "Subject: =?GB2312?B?dGVzdA==?=",
  "Content-Type: text/html; charset=\"utf-8\"",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "<html><body>",
  "<h2>=E4=BA=A4=E6=98=93=E4=BF=A1=E6=81=AF</h2><table><tr><td>=E5=8D=A1=E5=8F=B7</td><td>=E6=8C=81=E5=8D=A1=E4=BA=BA</td><td>=E4=BA=A4=E6=98=93=E6=97=B6=E9=97=B4</td><td>=E4=BA=A4=E6=98=93=E7=B1=BB=E5=9E=8B</td><td>=E6=B2=B9=E5=93=81</td><td>=E6=95=B0=E9=87=8F(=E5=8D=87)</td><td>=E5=8D=95=E4=BB=B7(=E5=85=83)</td><td>=E9=87=91=E9=A2=9D(=E5=85=83)</td><td>=E5=A5=96=E5=8A=B1=E5=88=86=E5=80=BC</td><td>=E4=BD=99=E9=A2=9D(=E5=85=83)</td><td>=E5=9C=B0=E7=82=B9</td></tr>",
  "<tr><td>1000113200006508614</td><td>=E4=BB=98=E6=96=8C</td><td>2024-01-02 07:30:04</td><td>=E6=B6=88=E8=B4=B9</td><td>95=E5=8F=B7=E6=B1=BD=E6=B2=B9</td><td>42.56</td><td>7.99</td><td>340.0</td><td>0.0</td><td>4360.0</td><td>=E6=89=AC=E5=B7=9E=E9=82=97=E5=9F=8E=E7=AB=99</td></tr>",
  "<tr><td colspan=3D\"11\">=E5=B0=8F=E8=AE=A1=EF=BC=9A</td></tr>",
  "</table></div>",
  "<h2>=E4=BB=98=E8=B4=B9=E4=BF=A1=E6=81=AF</h2><table><tr><td>=E5=BA=8F=E5=8F=B7</td><td>=E4=BB=98=E8=B4=B9=E6=97=B6=E9=97=B4</td><td>=E4=BB=98=E8=B4=B9=E5=9C=B0=E7=82=B9</td><td>=E6=94=B6=E6=AC=BE=E6=96=B9=E5=BC=8F</td><td>=E5=85=85=E5=80=BC=E9=87=91=E9=A2=9D(=E5=85=83)</td></tr>",
  "<tr><td>1</td><td>2024-01-02 07:32:43</td><td>=E6=98=93=E6=8D=B7=E7=BA=A2=E5=8C=85=E5=85=85=E5=80=BC=E7=BD=91=E7=82=B91</td><td>=null</td><td>305.54</td></tr>",
  "</table></body></html>",
].join("\r\n");

check("parseEmlSheets 按 h2 标题提取表格，quoted-printable 中文正常解码，小计行被剔除", () => {
  const sheets = parseEmlSheets(EML_BODY);
  assert.equal(sheets.length, 2);
  assert.equal(sheets[0].sheetName, "交易信息");
  assert.equal(sheets[0].rows.length, 2, "表头 + 1 条消费行，小计行剔除");
  assert.equal(sheets[0].rows[1][4], "95号汽油", "QP 字节应还原成 UTF-8 中文");
  assert.equal(sheets[0].rows[1][10], "扬州邗城站");
  assert.equal(sheets[1].sheetName, "付费信息");
  assert.equal(sheets[1].rows.length, 2);
});

const emlBuf = Buffer.from(EML_BODY, "latin1");
const emlFile = new File(
  [emlBuf.buffer.slice(emlBuf.byteOffset, emlBuf.byteOffset + emlBuf.byteLength) as ArrayBuffer],
  "中国石化加油卡对账单.eml",
  { type: "message/rfc822" },
);
const emlSheets = await readStatementSheetRows(emlFile);
const emlOut = parseStatementSheetsStandard(emlSheets, { sourceFileName: emlFile.name, fundAware: true });
check("eml 经 readStatementSheetRows → 识别器 → 消费/充值记录（含升数/单价/地点备注）", () => {
  assert.equal(emlOut.template, "sinopec");
  assert.equal(emlOut.rows.length - 1, 2); // 1 消费 + 1 充值
  const fuel = emlOut.rows[1];
  assert.equal(fuel[CAIZHI_COL.account], "中石化加油卡");
  assert.match(fuel[10], /数量\(升\):42\.56/);
  assert.match(fuel[10], /单价\(元\):7\.99/);
  assert.match(fuel[10], /地点:扬州邗城站/);
});

// 邮箱链路：mail.html 是已解码的 UTF-8 HTML 字符串（imap-client 的 simpleParser 已解 QP）。
const MAIL_HTML = [
  "<html><body>",
  "<h2>交易信息</h2><table><tr><td>卡号</td><td>持卡人</td><td>交易时间</td><td>交易类型</td><td>油品</td><td>数量(升)</td><td>单价(元)</td><td>金额(元)</td><td>奖励分值</td><td>余额(元)</td><td>地点</td></tr>",
  "<tr><td>1000113200006508614</td><td>付斌</td><td>2024-01-02 07:30:04</td><td>消费</td><td>95号汽油</td><td>42.56</td><td>7.99</td><td>340.0</td><td>0.0</td><td>4360.0</td><td>扬州邗城站</td></tr>",
  "</table></body></html>",
].join("");

check("邮箱链路 mail.html（已解码 HTML）走 parseHtmlSheets → sinopec，升数/单价/地点进备注", () => {
  const sheets = parseHtmlSheets(MAIL_HTML);
  assert.equal(sheets.length, 1);
  assert.equal(sheets[0].sheetName, "交易信息");
  const out = parseStatementSheetsStandard(sheets, { sourceFileName: "mail-statement.html", fundAware: true });
  assert.equal(out.template, "sinopec");
  assert.equal(out.rows.length - 1, 1);
  assert.equal(out.rows[1][CAIZHI_COL.account], "中石化加油卡");
  assert.match(out.rows[1][10], /数量\(升\):42\.56/);
  assert.match(out.rows[1][10], /单价\(元\):7\.99/);
  assert.match(out.rows[1][10], /地点:扬州邗城站/);
  assert.doesNotMatch(out.rows[1][10], /持卡人|卡号|交易类型/);
});

// PDF 表格优先（农商行电子流水）：
// 它的文字层是乱序的（「20241128 09:28:40苏KF17907原」+ 下一行「49.31元」），按行读会
// 把备注里的 17907 当金额；getTable() 才是干净的 4 列。同时每页页脚
// 「江苏扬州农村商业银行2026-11-24 19:05:12」会被拼进单元格、还会被列宽切成残片，
// 必须靠文字层反推水印名清洗，不能写死银行名。
const PDF_FOOTER = "江苏扬州农村商业银行2026-11-24 19:05:12";
const PDF_TABLES: string[][][] = [[
  ["江苏扬州农村商业银行交易流水"],
  ["交易时间", "收入/支出金额", "商户类型", "备注"],
  ["2024-11-29 10:03:27", "-49.31", "消费", "原20241128 09:28:40苏KF17907"],
  ["2024-11-29 12:08:54", "12.50", "转账", `京东商城业务${PDF_FOOTER}`],
  ["2024-11-30 08:31:02", "-230.00", "消费", "江苏扬州农村商业"],
]];

check("PDF 表格 → 规范 TSV：表头保留、非流水行丢弃、水印残片清空", () => {
  const text = buildStatementTableText(PDF_TABLES, PDF_FOOTER);
  assert.ok(text, "有「日期 + 金额」表头的表格应被接管");
  const rows = text.split("\n").map((line) => line.split("\t"));
  assert.deepEqual(rows[0], ["交易时间", "收入/支出金额", "商户类型", "备注"]);
  assert.equal(rows.length - 1, 3, "标题行不占数据行");
  assert.ok(
    rows.slice(1).every((cells) => cells.every((cell) => !/江苏扬州农村商业/.test(cell))),
    "页脚水印不能残留在任何单元格里",
  );
});

check("PDF 表格 → 标准模板：备注里的 苏KF17907 不再冒领金额", () => {
  const text = buildStatementTableText(PDF_TABLES, PDF_FOOTER)!;
  const rows = text.split("\n").map((line) => line.split("\t"));
  const items = parseStatementTemplateRows(rows, "", STATEMENT_IMPORT_FIELD_HEADERS, TEMPLATE_GUIDE_TITLE_HINTS);
  assert.equal(items.length, 3);
  // 标准模板把金额取绝对值、方向交给 type，所以这里比绝对值 + 方向关系。
  assert.deepEqual(items.map((item) => item.amount), [49.31, 12.5, 230]);
  assert.equal(items[0].type, items[2].type, "同为负数的两行方向应一致");
  assert.notEqual(items[0].type, items[1].type, "负数与正数方向应相反");
  assert.ok(!items.some((item) => Math.abs(item.amount) === 17907), "17907 是备注里的车牌，不是金额");
});

check("PDF 页眉卡号 → 补「账户」列（尾号2058 能匹配到已有信用卡）", () => {
  // 页眉 `6228 **** 2058` 落在表格外，必须由文字层学出来补进 TSV，
  // 否则整份流水没有账户，预览里逐条手选、尾号匹配也失效。
  const text = buildStatementTableText(PDF_TABLES, `6228 **** 2058\n${PDF_FOOTER}`)!;
  const rows = text.split("\n").map((line) => line.split("\t"));
  assert.equal(rows[0].at(-1), "账户");
  assert.ok(rows.slice(1).every((cells) => cells.at(-1) === "尾号2058"));
});

check("PDF 表格自带账户列时不重复追加", () => {
  const tables: string[][][] = [[
    ["交易时间", "收入/支出金额", "账户", "备注"],
    ["2024-11-29 10:03:27", "37.21", "京东联名", "京东支付"],
    ["2024-11-30 10:03:27", "22.22", "京东联名", "京东支付"],
    ["2024-12-01 10:03:27", "11.11", "京东联名", "京东支付"],
  ]];
  const text = buildStatementTableText(tables, "6228 **** 2058")!;
  const rows = text.split("\n").map((line) => line.split("\t"));
  assert.deepEqual(rows[0], ["交易时间", "收入/支出金额", "账户", "备注"]);
  assert.ok(rows.slice(1).every((cells) => cells[2] === "京东联名"));
});

check("PDF 表格不是流水时不接管（退回文字流）", () => {
  const notStatement = [[["项目", "说明"], ["备注", "无"], ["合计", "1"]]];
  assert.equal(buildStatementTableText(notStatement, ""), null);
});

check("信用卡账单（文字层带账单摘要）不被表格接管，专用模板照旧", () => {
  // 摘要只在原文里，换成 4 列 TSV 会让专用模板看不到「本期应还」，
  // 账期锁定与额度补档案全失效——新功能不能覆盖旧功能。
  const text = `平安银行信用卡账单\n本期应还金额 1234.56\n到期还款日 2022-03-05\n${PDF_FOOTER}`;
  assert.equal(buildStatementTableText(PDF_TABLES, text), null);
});

check("PDF 表格：备注里的「商户名 + 日期」不被当成页脚删掉", () => {
  const tables: string[][][] = [[
    ["交易时间", "收入/支出金额", "商户类型", "备注"],
    ["2024-11-29 10:03:27", "-49.31", "消费", "京东商城业务2026-11-24 19:05:12"],
    ["2024-11-29 12:08:54", "12.50", "转账", "京东商城业务"],
    ["2024-11-30 08:31:02", "-230.00", "消费", "京东商城业务"],
  ]];
  const text = buildStatementTableText(tables, PDF_FOOTER)!;
  assert.ok(text.includes("京东商城业务"), "商户名必须保留");
});

// 加密 PDF 的两类失败必须分开：密码问题要给输入框，加密方式不认要给「另存为未加密 PDF」
// 的引导。混成一句「解析失败 / 文件可能已损坏」会让用户以为少弹了密码框（农商行流水默认加密）。
check("PDF 报错分类：密码问题 ≠ 加密方式不受支持", () => {
  assert.deepEqual(classifyPdfParseError("No password given"), {
    passwordRequired: true,
    passwordIncorrect: false,
    encryptionUnsupported: false,
  });
  assert.deepEqual(classifyPdfParseError("Incorrect Password"), {
    passwordRequired: true,
    passwordIncorrect: true,
    encryptionUnsupported: false,
  });
  for (const message of [
    "unsupported encryption algorithm",
    "unknown encryption method",
    "Unknown crypto method",
    "Invalid crypt filter name",
  ]) {
    const result = classifyPdfParseError(message);
    assert.equal(result.passwordRequired, false, `${message} 不该弹密码框`);
    assert.equal(result.encryptionUnsupported, true, `${message} 应判为加密方式不受支持`);
  }
  const other = classifyPdfParseError("Invalid PDF structure");
  assert.equal(other.passwordRequired, false);
  assert.equal(other.encryptionUnsupported, false, "普通解析错误不能被说成加密问题");
});

// 2026-11-26 生产事故：0.1.91 把 pdf-parse 1.x 升到 2.x 之后，standalone 产物里
// 只有 @napi-rs/canvas 的 JS、没有平台二进制（nft 追踪不到它的动态 require），pdfjs
// 给图片蒙版（银行流水水印）描边时 `new DOMMatrix()` 直接 ReferenceError，所有 PDF
// 附件都报「文件可能已损坏」，连加密 PDF 的密码框都不弹。shim 必须在没有原生 canvas
// 的环境里补出可用矩阵。
check("PDF 解析：没有原生 canvas 时自补 DOMMatrix", () => {
  const scope = globalThis as Record<string, unknown>;
  const original = scope.DOMMatrix;
  delete scope.DOMMatrix;
  try {
    installPdfCanvasShim();
    type Matrix = {
      a: number;
      b: number;
      c: number;
      d: number;
      e: number;
      f: number;
      scaleSelf: (sx: number, sy?: number) => Matrix;
      translateSelf: (tx?: number, ty?: number) => Matrix;
    };
    const MatrixCtor = scope.DOMMatrix as unknown as new () => Matrix;
    assert.equal(typeof MatrixCtor, "function");
    // pdfjs 的唯一用法：new DOMMatrix().scaleSelf(1/width, -1/height).translateSelf(0, -height)
    const matrix = new MatrixCtor().scaleSelf(1 / 100, -1 / 50).translateSelf(0, -50);
    assert.ok(Math.abs(matrix.a - 0.01) < 1e-9, "a 必须等于 1/width");
    assert.ok(Math.abs(matrix.d + 0.02) < 1e-9, "d 必须等于 -1/height");
    assert.ok(Math.abs(matrix.f - 1) < 1e-9, "y 轴翻转后 f 必须回到 1");
    assert.equal(matrix.e, 0);
  } finally {
    if (original === undefined) delete scope.DOMMatrix;
    else scope.DOMMatrix = original;
  }
});

console.log(`\ncheck:recognizer ok（${assertionCount} 条断言）`);
})();
