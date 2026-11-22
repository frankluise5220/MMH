// 农行金穗信用卡 HTML 账单解析器 —— `npm run check:abc-credit-card`。
//
// 用真实账单（QQ 邮箱「其他文件夹/信用卡」里 2020~2022 的金穗电子对账单）的
// 结构做离线断言：竖排表头也能认出交易，负数=支出、正数=还款入账（transfer），
// 不复现「把客服热线 021-61195599 当交易 / 日期 6119-55-99」的旧 bug。
//
// 纯离线：不连库、不连邮箱、不读用户文件。

import assert from "node:assert/strict";
import { emlBodyHtml, parseEmlBody, parseHtmlSheets } from "../src/lib/statement/eml-sheet-reader";
import {
  isAbchinaCreditCardStatement,
  parseAbchinaCreditCardStatement,
} from "../src/lib/statement/abchina-credit-card";

function row(cells: string[]) {
  return `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
}

function statementHtml(rows: string[]) {
  return `<html><head><meta charset="gbk"></head><body>
    <table>${[
      row(["尊敬的付斌先生：感谢您长期以来对金穗信用卡的支持。"]),
      row(["卡号", "625998******6328", "账单周期", "20220913-20221012", "到期还款日", "20221031"]),
      row(["币种", "本期应还款额(欠款为-)", "最低还款额(欠款为-)", "信用额度"]),
      row(["人民币(CNY)", "-106.00", "-5.30", "26000.00"]),
      row(["【账务明细】"]),
      row(["【交易明细】"]),
      row(["交易日"]), row(["TDate"]), row(["入账日期"]), row(["PDate"]),
      row(["卡号后四位"]), row(["Card No."]), row(["交易摘要"]), row(["Type"]),
      row(["交易地点"]), row(["City/Merchant Name/Branches"]),
      row(["交易金额/币种"]), row(["Tran Amt/Curr"]),
      row(["入账金额/币种(支出为-)"]), row(["Sett Amt/Curr"]),
      ...rows,
      row(["【温馨提示】您可使用最低还款额方式还款。"]),
      row(["安全提示"]), row(["客服热线4006695599或021-61195599"]),
    ].join("")}</table></body></html>`;
}

const html = statementHtml([
  row(["", "20220918", "20220918", "6328", "网上消费", "支付宝，绥芬河市祥光经贸有限公司", "58.00/CNY", "-58.00/CNY"]),
  row(["", "20220926", "20220926", "6328", "网上消费", "支付宝，扬州品胜食品有限公司", "48.00/CNY", "-48.00/CNY"]),
  row(["", "20220926", "20220926", "6328", "银联入账", "付斌/付款尾号:2556/", "5269.57/CNY", "5269.57/CNY"]),
]);

assert.equal(isAbchinaCreditCardStatement(html), true, "农行金穗账单应被认出");
assert.equal(isAbchinaCreditCardStatement("<html><tr><td>招商银行信用卡账单</td></tr></html>"), false, "他行账单不应命中");

const items = parseAbchinaCreditCardStatement(html, (text) =>
  /支付宝/.test(text) ? { counterparty: "支付宝", institution: "支付宝", category: "购物" } : {},
);
console.log("items:", JSON.stringify(items, null, 2));

assert.equal(items.length, 3, "应解析出 3 笔交易（不是客服热线那 1 条垃圾）");
assert.deepEqual(items.map((item) => item.date), ["2022-09-18", "2022-09-26", "2022-09-26"]);
assert.deepEqual(items.map((item) => item.type), ["expense", "expense", "transfer"]);
assert.deepEqual(items.map((item) => item.amount), [58, 48, 5269.57]);
assert.equal(items[0].outflow, 58);
assert.equal(items[2].inflow, 5269.57);
assert.equal(items[2].fromAccount, "银联入账尾号2556");
assert.equal(items[0].account, "农业银行信用卡(6328)");
assert.equal(items[0].counterparty, "支付宝");
assert.equal(items[0]._meta?.ownerName, "付斌");
assert.equal(items[0]._meta?.cardNumberMasked, "6328");
assert.equal(items[0]._meta?.statementPeriodStart, "2022-09-13");
assert.equal(items[0]._meta?.statementPeriodEnd, "2022-10-12");
assert.equal(items[0]._meta?.statementDueDate, "2022-10-31");
assert.equal(items[0]._meta?.creditLimit, 26000);
assert.equal(items[0]._meta?.statementAmount, 106);
assert.equal(items.every((item) => !/6119|21$/.test(item.date ?? "")), true, "不得出现 6119-55-99 这类电话误判");

// 交易地点为空的「卡卡转账」行（2021 年模板）也能解析。
const sparse = statementHtml([
  row(["", "20210120", "20210120", "7772", "卡卡转账", "4756.41/CNY", "4756.41/CNY"]),
]);
const sparseItems = parseAbchinaCreditCardStatement(sparse);
assert.equal(sparseItems.length, 1, "空交易地点行也应解析");
assert.equal(sparseItems[0].type, "transfer");
assert.equal(sparseItems[0].amount, 4756.41);

// ── 商户分期：一条消费拆三条（消费 / 冲抵 / 本期本金），净额=本期应还本金 ──
function installmentHtml() {
  return `<html><head><meta charset="gbk"></head><body><table>${[
    row(["尊敬的金穗信用卡持卡人：本对账单为您的金穗信用卡账户信息。"]),
    row(["卡号", "625996******6308", "账单周期", "20200714-20200813", "到期还款日", "20200907"]),
    row(["币种", "本期应还款额(欠款为-)", "最低还款额(欠款为-)", "信用额度"]),
    row(["人民币(CNY)", "-1325.20", "-968.76", "26000.00"]),
    row(["【交易明细】"]),
    row(["交易日"]), row(["TDate"]), row(["入账日期"]), row(["PDate"]),
    row(["卡号后四位"]), row(["Card No."]), row(["交易摘要"]), row(["Type"]),
    row(["交易地点"]), row(["City/Merchant Name/Branches"]),
    row(["交易金额/币种"]), row(["Tran Amt/Curr"]),
    row(["入账金额/币种(支出为-)"]), row(["Sett Amt/Curr"]),
    row(["", "20200731", "20200731", "6308", "商户分期", "泰州苏宁易购商贸有限公司", "5698.00/CNY", "-5698.00/CNY"]),
    row(["", "20200807", "20200807", "", "约定还款", "40.93/CNY", "40.93/CNY"]),
    row(["【分期明细】"]),
    row(["分期类型"]), row(["Instal.Type"]), row(["分期日期"]), row(["Date"]),
    row(["分期总本金/币种"]), row(["Total Amt/Curr"]), row(["总期数"]), row(["Months"]),
    row(["当期期数"]), row(["Cur Month"]), row(["剩余期数"]), row(["Rmng Months"]),
    row(["本期应还本金/币种"]), row(["Payment/Curr"]), row(["剩余分期本金/币种"]), row(["Balance/Curr"]),
    row(["商户分期", "20200731", "5698.00/CNY", "6", "1", "5", "950.00/CNY", "4748.00/CNY"]),
    row(["【温馨提示】您可使用最低还款额方式还款。"]),
  ].join("")}</table></body></html>`;
}

const instItems = parseAbchinaCreditCardStatement(installmentHtml());
assert.equal(instItems.length, 4, "商户分期拆三条（消费/冲抵/本期本金）+ 约定还款");
const instSpend = instItems.find((item) => item.outflow === 5698);
const instOffset = instItems.find((item) => item.inflow === 5698);
const instPrincipal = instItems.find((item) => item.amount === 950 && item.outflow === 950);
assert.ok(instSpend && instOffset && instPrincipal, "三条分期行都要在");
assert.equal(instSpend.type, "expense", "原消费仍是正常消费支出");
assert.equal(instSpend.date, "2020-07-31");
assert.equal(instSpend.remark, "商户分期 泰州苏宁易购商贸有限公司", "消费行就是一笔正常消费，备注不写分期");
assert.equal(instSpend.category, undefined, "消费行照原分类识别，识别不到就留空（未分类），不能挂银行分期");
assert.equal(instOffset.type, "expense", "冲抵行仍是支出大类（正数=负支出，靠 inflow 落到账户）");
assert.equal(instOffset.remark, "商户分期 泰州苏宁易购商贸有限公司（分期冲抵：转分期本金 5698.00，分 6 期，分期日 2020-07-31）");
assert.equal(instOffset.category, "银行分期", "冲抵行不管商户是谁，都归银行分期");
assert.equal(instPrincipal.type, "expense", "本期本金行是支出");
assert.equal(instPrincipal.category, "银行分期", "本金行归银行分期");
assert.equal(instPrincipal.remark, "商户分期 泰州苏宁易购商贸有限公司（分期本金 1/6，本期应还 950.00，剩余本金 4748.00）");
assert.equal(instSpend._meta?.templateLocked, true, "分期行应锁定，避免下游改写方向");
assert.equal(instOffset._meta?.templateLocked, true);
assert.equal(instSpend.account, "农业银行信用卡(6308)", "分期卡 6308 与主卡 6316 要区分");
assert.equal(instSpend._meta?.cardNumberMasked, "6308");
// 三条净额必须等于本期应还本金 950（5698 消费 - 5698 冲抵 + 950 本金）
assert.equal(
  Number((instItems.filter((item) => item.date === "2020-07-31").reduce((acc, item) => acc + (item.outflow ?? 0) - (item.inflow ?? 0), 0)).toFixed(2)),
  950,
  "分期三条净额应等于本期应还本金",
);

// ── 有商户别名时：消费行取原分类，冲抵/本金行恒为银行分期 ──
const aliasedItems = parseAbchinaCreditCardStatement(installmentHtml(), (text) =>
  text.includes("苏宁易购") ? { category: "购物", counterparty: "苏宁易购" } : {},
);
assert.equal(aliasedItems.find((item) => item.outflow === 5698)?.category, "购物", "消费行按原分类识别");
assert.equal(aliasedItems.find((item) => item.inflow === 5698)?.category, "银行分期", "冲抵行不被别名改写");
assert.equal(
  aliasedItems.find((item) => item.amount === 950 && item.outflow === 950)?.category,
  "银行分期",
  "本金行不被别名改写",
);

// ── 往期分期的续期：本期交易明细里没有消费行，只补当期应还本金（含提前结清） ──
const renewalHtml = `<html><head><meta charset="gbk"></head><body><table>${[
  row(["尊敬的金穗信用卡持卡人：本对账单为您的金穗信用卡账户信息。"]),
  row(["卡号", "625996******6308", "账单周期", "20200814-20200913", "到期还款日", "20201008"]),
  row(["【交易明细】"]),
  row(["交易日"]), row(["TDate"]), row(["入账日期"]), row(["PDate"]),
  row(["", "20200910", "20200910", "6308", "网上消费", "支付宝，测试商户", "19.00/CNY", "-19.00/CNY"]),
  row(["【分期明细】"]),
  row(["分期类型"]), row(["Instal.Type"]), row(["分期日期"]), row(["Date"]),
  row(["分期总本金/币种"]), row(["Total Amt/Curr"]), row(["总期数"]), row(["Months"]),
  row(["当期期数"]), row(["Cur Month"]), row(["剩余期数"]), row(["Rmng Months"]),
  row(["本期应还本金/币种"]), row(["Payment/Curr"]), row(["剩余分期本金/币种"]), row(["Balance/Curr"]),
  row(["商户分期", "20200731", "5698.00/CNY", "6", "2", "0", "4748.00/CNY", "0.00/CNY"]),
  row(["【温馨提示】您可使用最低还款额方式还款。"]),
].join("")}</table></body></html>`;
const renewalItems = parseAbchinaCreditCardStatement(renewalHtml);
assert.equal(renewalItems.length, 2, "续期只补一条本金行，不得再造消费与冲抵");
const renewal = renewalItems.find((item) => item.category === "银行分期");
assert.ok(renewal, "提前结清应落一条本金行");
assert.equal(renewal.amount, 4748, "提前结清额取本期应还本金");
assert.equal(renewal.type, "expense");
assert.equal(renewal.date, "2020-09-13", "续期行落在本期账期末，不回到分期日");
assert.equal(renewal.account, "农业银行信用卡(6308)");
assert.equal(
  renewal.remark,
  "商户分期（分期本金 2/6，总本金 5698.00，分期日 2020-07-31，剩余本金 0.00）",
);
assert.equal(renewal._meta?.templateLocked, true);

// ── 多卡账单：单头的「本期应还/信用额度」只属于表头主卡，不能复制给附属卡 ──
const multiCard = `<html><head><meta charset="gbk"></head><body><table>${[
  row(["尊敬的金穗信用卡持卡人：以下为本期金穗信用卡对账单。"]),
  row(["卡号", "625996******6308", "账单周期", "20200714-20200813", "到期还款日", "20200907"]),
  row(["币种", "本期应还款额(欠款为-)", "最低还款额(欠款为-)", "信用额度"]),
  row(["Curr", "New Balance", "Min Payment", "Credit Limit"]),
  row(["人民币(CNY)", "-1325.20", "-968.76", "26000.00"]),
  row(["【交易明细】"]),
  row(["交易日"]), row(["TDate"]),
  row(["", "20200807", "20200807", "6308", "网上消费", "主卡消费", "40.93/CNY", "-40.93/CNY"]),
  row(["", "20200808", "20200808", "6316", "网上消费", "附属卡ETC", "19.00/CNY", "-19.00/CNY"]),
  row(["【温馨提示】"]),
].join("")}</table></body></html>`;
const multiItems = parseAbchinaCreditCardStatement(multiCard);
assert.equal(multiItems.length, 2, "主卡与附属卡交易都要保留");
const mainRow = multiItems.find((item) => item._meta?.cardNumberMasked === "6308");
const subRow = multiItems.find((item) => item._meta?.cardNumberMasked === "6316");
assert.ok(mainRow && subRow, "两张卡的卡号令牌都要带出");
assert.equal(mainRow._meta?.statementAmount, 1325.2, "主卡行应带单头应还额");
assert.equal(subRow._meta?.statementAmount, undefined, "附属卡行不得带主卡的单头应还额（否则账单锁定错挂）");
assert.equal(subRow._meta?.creditLimit, undefined, "附属卡行不得带主卡的信用额度");
assert.equal(subRow._meta?.institutionName, "农业银行", "附属卡行仍保留机构令牌");
assert.equal(subRow.account, "农业银行信用卡(6316)", "附属卡账户要区分");
assert.equal(mainRow._meta?.cardRole, "primary", "账单抬头那张卡判为主卡");
assert.equal(subRow._meta?.cardRole, "supplementary", "同账单里的其它卡号判为附属卡");
assert.equal(subRow._meta?.primaryCardMasked, "6308", "附属卡要记住主卡卡号后四位");
assert.equal(mainRow._meta?.primaryCardMasked, undefined, "主卡不记主卡卡号");

// ── 抬头卡号缺失：判不出主卡，一律按主卡处理，不许猜 ──
const noHeaderCard = `<html><head><meta charset="gbk"></head><body><table>${[
  row(["尊敬的金穗信用卡持卡人：以下为本期金穗信用卡对账单。"]),
  row(["【交易明细】"]),
  row(["交易日"]), row(["TDate"]),
  row(["", "20200807", "20200807", "6308", "网上消费", "无名", "40.93/CNY", "-40.93/CNY"]),
  row(["", "20200808", "20200808", "6316", "网上消费", "无名", "19.00/CNY", "-19.00/CNY"]),
  row(["【温馨提示】"]),
].join("")}</table></body></html>`;
const noHeaderItems = parseAbchinaCreditCardStatement(noHeaderCard);
assert.equal(noHeaderItems.length, 2);
assert.deepEqual(
  noHeaderItems.map((item) => item._meta?.cardRole),
  ["primary", "primary"],
  "抬头没有卡号时不得凭空判附属卡",
);

// 非农行 HTML 不产出，交给别的模板。
assert.deepEqual(parseAbchinaCreditCardStatement("<html><tr><td>工商银行</td></tr></html>"), []);

// ── .eml 正文解码：农行真实形态是「Content-Transfer-Encoding: base64 + charset=""」 ──
function encodeBase64(bytes: Uint8Array) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const triplet = (a << 16) | (b << 8) | c;
    out += alphabet[(triplet >> 18) & 63];
    out += alphabet[(triplet >> 12) & 63];
    out += i + 1 < bytes.length ? alphabet[(triplet >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? alphabet[triplet & 63] : "=";
  }
  return out;
}

// 「银行」的 GBK 字节（D2 F8 D0 D0）拼进 ASCII 骨架，用来验证 charset="" 时的编码探测。
const gbkBody = new Uint8Array([
  ...new TextEncoder().encode("<html><head><meta charset=gbk></head><body><table><tr><td>ABC"),
  0xd2,
  0xf8,
  0xd0,
  0xd0,
  ...new TextEncoder().encode("</td></tr></table></body></html>"),
]);
const eml = [
  "Return-Path: <bill@abchina.com>",
  "",
  "Subject: 金穗信用卡电子对账单",
  "Content-Type: Text/HTML;",
  '\tcharset=""',
  "Content-Transfer-Encoding: base64",
  "",
  encodeBase64(gbkBody),
  "",
].join("\r\n");
assert.match(parseEmlBody(eml), /ABC银行/, "base64 正文 + 空 charset 必须按 GBK 探测解出中文");
assert.match(emlBodyHtml(eml), /<table>/, "解出来的必须是可直接交给解析器的 HTML");

// 嵌套布局表：外层表含内层表时，按深度配对，不能把内层 </table> 当外层结束。
const nestedHtml =
  "<html><body><table><tr><td>" +
  "<table><tr><td>2020-07-31</td><td>商户分期</td><td>-5698.00</td></tr>" +
  "<tr><td>2020-08-03</td><td>约定还款</td><td>1325.20</td></tr></table>" +
  "</td></tr></table></body></html>";
const nestedSheets = parseHtmlSheets(nestedHtml);
assert.equal(nestedSheets.length, 1, "只收叶子表，外层布局表不单独成表");
assert.deepEqual(nestedSheets[0].rows[1], ["2020-08-03", "约定还款", "1325.20"], "嵌套表的两行都要提出来");

console.log("check:abc-credit-card PASS");
