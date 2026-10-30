// 账单 CSV 的编码探测与支付宝模板识别 —— `npm run check:csv-import`。
//
// 支付宝 / 微信在 Windows 上导出的账单是 GBK(GB18030) 文本，`File.text()` 一律按
// UTF-8 解码，拿到的是整表乱码：表头别名全部匹配不上，支付宝模板就此落空，
// 预览只剩一堆错位列（用户报告「导入支付宝交易明细时预览混乱」）。
//
// 断言：
// 1. GBK 字节能正确解码成中文，且确实不是合法 UTF-8（否则样本无效、断言无意义）；
// 2. UTF-8（带 / 不带 BOM）字节解码正确，BOM 不残留；
// 3. GBK 的支付宝账单能命中支付宝模板，日期 / 收支 / 金额 / 账户 / 机构都对；
// 4. 表头落在旧 25 行扫描窗口之外时（支付宝回单说明行变多）依然能命中；
// 5. 微信账单表头不会被支付宝模板误判（微信是「当前状态」，支付宝是「交易状态」）。
//
// 纯离线：不连数据库、不读用户文件。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { decodeTextBytes } from "../src/lib/client/decode-text-file";
import {
  guessAlipayOwnerFromFilename,
  normalizeAlipayWorkbookRows,
} from "../src/lib/statement/alipay-template";
import { extractAlipayFundName, extractAlipayFundTrades } from "../src/lib/statement/alipay-fund-trade";
import { excludeFundTradeRows } from "../src/lib/statement/alipay-fund-import-file";
import {
  matchFundNameToCode,
  splitFundShareClass,
} from "../src/lib/fund/fund-name-match";
import { pickFundSearchCandidate } from "../src/lib/fund/fund-name-search";
import {
  isSpreadsheetWorkbookFile,
  parseStatementCsv,
} from "../src/lib/statement/statement-sheet-reader";
import { normalizeJdWorkbookRows } from "../src/lib/statement/jd-template";
import { normalizeWechatWorkbookRows } from "../src/lib/statement/wechat-template";

// 支付宝账单样本（GBK 字节，base64）。内容为构造数据，不含任何真实账单信息。
const GBK_SAMPLE_BASE64 =
  "LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tDQq1vLP20MXPoqO6DQrQ1cP7o7qy4srU08O7pw0K1qe4trGm1cu7p6O6dGVzdEBleGFtcGxlLmNvbQ0KxvDKvMqxvOSjulsyMDI2LTA3LTI4IDAwOjAwOjAwXSAgICDW1da5yrG85KO6WzIwMjYtMTAtMjggMjM6NTk6NTldDQq1vLP2vbvS18Dg0M2julvIq7K/XQ0Ktbyz9sqxvOSjulsyMDI2LTEwLTI4IDIyOjA3OjQyXQ0KubIyscq8x8K8DQrK1cjro7oxscogMTAwLjAw1KoNCtans/ajujGxyiAzMy4wMNSqDQqyu7zGytXWp6O6MLHKIDAuMDDUqg0KDQrM2LHwzOHKvqO6DQoxLrG+u9i1pcTayN2/ybHtw/fWp7i2sabK3MDtwcvP4NOm1qe4tr270tfJ6sfro6zS8s+1zbPUrdLyu/LNqNG2ucrVz7XIxby3otLyy9i1vNbCsb672LWl0+vKtbzKvbvS173hufuyu7f7yrGjrNLUyrW8yr270tfH6b/2zqrXvKO7DQoyLsfrzvC9q7G+u9i1pdf3zqrK1b/ut723orv1tcTGvr7dyrnTw6Osx+uy6dak1cu7p8q1vMq1vdXLx+m/9rrz1Nm9+NDQt6K79bLZ1/ejuw0KMy7Wp7i2saa/7L3d1qe4trXIt8fT4Lbu1qe4tre9yr2/ycTcvMiy+sn61qe4trGmvbvS19KyzayyvbL6yfrS+NDQvbvS16Os0vK0y8frzvDKudPDsb672LWlvfjQ0NbYuLS8x9XLo7sNCjQusb672LWlyOe+rcjOus7Nv7jEoaKx4NTso6y++cGivLTKp8il0KfBpqO7DQo1LrK/t9bVy7WlyOejurPk1rXM4c/WoaLVy7un16q05rvy1d+49sjLyejWw8rV1qe1yLK7vMbI686qytXI67vy1d/Wp7P2o6y8x86qsru8xsrV1qfA4KO7DQo2LtLyzbO8xsLfvK2yu82so6zD98+4vfC27taxvdPA27zTuvOjrL/JxNy74brNz8K3vc2zvMa98LbusrvSu9bCo6zH69LUyrW8yr270te98LbuzqrXvKO7DQo3Lr371rm9q7G+u9i1pdPD09q3x7eo08PNvqO7DQo4LrG+w/fPuL32uam49sjLttTVy8q508Ohow0KDQotLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS3Wp7i2sabWp7i2v8a8vNPQz965q8u+ICC159fTv827p7vYtaUtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0NCr270tfKsbzkLL270te31sDgLL270te21Le9LLbUt73Vy7rFLMnMxrfLtcP3LMrVL9anLL3wtu4sytUvuLa/7re9yr0svbvS19e0zKwsvbvS17aptaW6xSzJzLzStqm1pbrFLLG416IsDQoyMDI2LTEwLTI4IDEyOjAwOjAwLLLN0vvDwMqzLMSzv+yyzbXqLHN0b3JlKioqQGV4YW1wbGUuY29tLM7nss0s1qez9iwzMy4wMCy7qN/CLL270tezybmmLDIwMjYxMDI4MjMwMDAwMDEsTU8yMDI2MTAyODAxLA0KMjAyNi0xMC0yNyAwOTowMDowMCzXqtXLuuyw/CzEs7rD09EsZnJpZW5kKioqQGV4YW1wbGUuY29tLNeq1cssytXI6ywxMDAuMDAs0+C27iy9u9LXs8m5piwyMDI2MTAyNzIzMDAwMDAyLE1PMjAyNjEwMjcwMiwNCg==";

// 期望的归一化表头：日期|收支大类|流出|流入|金额|账户|对向账户|分类|收支机构|备注|第二备注
const EXPECTED_HEADERS_B64 =
  "5pel5pyffOaUtuaUr+Wkp+exu3zmtYHlh7p85rWB5YWlfOmHkeminXzotKbmiLd85a+55ZCR6LSm5oi3fOWIhuexu3zmlLbmlK/mnLrmnoR85aSH5rOofOesrOS6jOWkh+azqA==";

// 交易时间|支出|收入|支付宝|测试用户支付宝花呗
const EXPECTED_TEXTS_B64 =
  "5Lqk5piT5pe26Ze0fOaUr+WHunzmlLblhaV85pSv5LuY5a6dfOa1i+ivleeUqOaIt+aUr+S7mOWuneiKseWRlw==";

function decodeUtf8Base64(base64: string) {
  return Buffer.from(base64, "base64").toString("utf8");
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      row.push(cell.trim());
      cell = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i++;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

const expectedHeaders = decodeUtf8Base64(EXPECTED_HEADERS_B64).split("|");
const [tradeTime, expenseText, incomeText, alipayText, ownerHuabeiAccount] =
  decodeUtf8Base64(EXPECTED_TEXTS_B64).split("|");

const gbkBytes = new Uint8Array(Buffer.from(GBK_SAMPLE_BASE64, "base64"));
const gbkText = decodeTextBytes(gbkBytes);

// 1. GBK 样本必须不能按 UTF-8 严格解码，否则这个用例根本测不到编码分支。
assert.throws(
  () => new TextDecoder("utf-8", { fatal: true }).decode(gbkBytes),
  "GBK sample must not decode as strict UTF-8",
);
assert.ok(!gbkText.includes("\ufffd"), "GBK decoding must not contain U+FFFD");
assert.ok(gbkText.includes(tradeTime), "GBK decoding must contain the bill header");
assert.ok(gbkText.includes(alipayText), "GBK decoding must contain the receipt title");

// 2. UTF-8（带 / 不带 BOM）必须原样解码。
const utf8Text = `${expectedHeaders.join(",")}\n2026-10-28 12:00:00,x,y,z,w,${expenseText},33.00,huabei,ok,1,2,`;
const utf8Bytes = new TextEncoder().encode(utf8Text);
assert.equal(decodeTextBytes(utf8Bytes), utf8Text, "UTF-8 without BOM must round-trip");
assert.equal(
  decodeTextBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8Bytes])),
  utf8Text,
  "UTF-8 with BOM must decode without the BOM",
);

// 3. GBK 的支付宝账单必须命中支付宝模板。
const gbkRows = parseCsv(gbkText);
const alipay = normalizeAlipayWorkbookRows([{ sheetName: "alipay", rows: gbkRows }]);
assert.ok(alipay, "GBK Alipay bill must hit the Alipay template");
assert.equal(alipay.rows.length - 1, 2, "sample must yield 2 data rows");
assert.deepEqual(alipay.rows[0], expectedHeaders, "normalized headers must be the fixed MMH columns");
const expenseRow = alipay.rows[1];
assert.equal(expenseRow[0], "2026-10-28", "date must normalize to YYYY-MM-DD");
assert.equal(expenseRow[1], expenseText, "major type must be expense");
assert.equal(expenseRow[2], "33", "outflow must be 33");
assert.equal(expenseRow[3], "", "inflow must be empty");
assert.equal(expenseRow[5], ownerHuabeiAccount, "account must combine the export owner and the payment method");
assert.equal(expenseRow[8], alipayText, "institution must be alipay");
assert.equal(alipay.rows[2][1], incomeText, "second row major type must be income");
assert.equal(alipay.rows[2][3], "100", "second row inflow must be 100");

// 4. 表头落在旧 25 行扫描窗口之外时（支付宝回单说明行变多）依然要命中。
const paddedRows = [...Array.from({ length: 20 }, () => ["note"]), ...gbkRows];
const paddedAlipay = normalizeAlipayWorkbookRows([{ sheetName: "alipay", rows: paddedRows }]);
assert.ok(paddedAlipay, "header beyond the old 25-row window must still hit the template");
assert.equal(paddedAlipay.rows.length - 1, 2, "padded sample must still yield 2 data rows");

// 5. 微信账单表头不得被支付宝模板误判（微信是「当前状态」，支付宝是「交易状态」）。
const wechatRows = [
  decodeUtf8Base64(
    "5Lqk5piT5pe26Ze0LOS6pOaYk+exu+WeiyzkuqTmmJPlr7nmlrks5ZWG5ZOBLOaUti/mlK8s6YeR6aKdKOWFgyks5pSv5LuY5pa55byPLOW9k+WJjeeKtuaAgSzkuqTmmJPljZXlj7cs5ZWG5oi35Y2V5Y+3LOWkh+azqA==",
  ).split(","),
  decodeUtf8Base64(
    "MjAyNi0xMC0yOCAxMjowMDowMCzllYblk4Hph4fotK0s5ZWG5a62LHN0b3JlKioqQGV4YW1wbGUuY29tLOWNiOmkkCzmlK/lh7osMzMuMDAs6Zu26ZKxLOaUr+S7mOaIkOWKnywyMDI2MTAyODIzMDAwMDAxLE1PMjAyNjEwMjgwMSw=",
  ).split(","),
];
assert.equal(
  normalizeAlipayWorkbookRows([{ sheetName: "wechat", rows: wechatRows }]),
  null,
  "wechat header must not be captured by the alipay template",
);

// 6. 京东账单必须走京东模板，且不能被放宽后的支付宝模板抢走。
//    京东表头的「交易状态 / 交易分类 / 商家订单号」与支付宝重叠，只有「商户名称」
//    是它的专属列 —— 一旦支付宝命中条件再放宽，这条断言就是刹车。
const jdSheet = [{
  sheetName: "jd",
  rows: [
    ["导出信息："],
    ["京东账号码名：test_user"],
    ["交易时间", "商户名称", "交易说明", "金额", "收/付款方式", "交易状态", "收/支", "交易分类", "交易订单号", "商家订单号", "备注"],
    ["2026-06-30 03:48:49", "京东小金库", "京东小金库收益", "0.07", "京东小金库", "交易成功", "收入", "小金库", "20260630173004042402", "20260630173004042402", ""],
  ],
}];
assert.ok(normalizeJdWorkbookRows(jdSheet), "JD bill must hit the JD template");
assert.equal(normalizeAlipayWorkbookRows(jdSheet), null, "JD bill must NOT be captured by the alipay template");
assert.equal(normalizeWechatWorkbookRows(jdSheet), null, "JD bill must NOT be captured by the wechat template");

// 7. 花呗 / 信用卡自动还款：支付宝记为「不计收支」，语义是账户互转 → 转账。
//    付款方式账户（余额宝）转出，被还款的账户（交易对方：花呗）转入。
const gbkHeaderIndex = gbkRows.findIndex((row) => row.includes(tradeTime));
const repaymentRows = [
  ...gbkRows.slice(0, gbkHeaderIndex),
  ["交易时间", "交易分类", "交易对方", "对方账号", "商品说明", "收/支", "金额", "收/付款方式", "交易状态", "交易订单号", "商家订单号", "备注"],
  ["2026/10/20 11:17", "信用借还", "花呗", "/", "花呗自动还款-2026年10月账单", "不计收支", "2188.42", "余额宝", "还款成功", "2026102029020999940181988854", "", ""],
];
const repayment = normalizeAlipayWorkbookRows([{ sheetName: "alipay", rows: repaymentRows }]);
assert.ok(repayment, "alipay repayment bill must hit the alipay template");
assert.equal(repayment.rows[1][0], "2026-10-20", "repayment date must normalize");
assert.equal(repayment.rows[1][1], "转账", "auto repayment must be a transfer, not an expense");
assert.equal(repayment.rows[1][2], "2188.42", "repayment must be an outflow");
assert.equal(repayment.rows[1][3], "", "repayment must not be an inflow");
assert.equal(repayment.rows[1][5], "测试用户支付宝余额宝", "repayment source must be the owner's Yu'ebao account");
assert.equal(repayment.rows[1][6], "测试用户支付宝花呗", "repayment target must be the Huabei account");
assert.equal(repayment.rows[1][9], "花呗自动还款-2026年10月账单", "product text must stay in the remark");

// 8. 文件名前缀是账本里的实际所有人，优先于账单内部写的导出者姓名。
//    场景：同一份账单（内部「姓名：付斌」）被命名为「张四.支付宝交易明细(...).csv」，
//    表示这本账要记在张四名下，账户就得是「张四支付宝xxx」而不是「付斌支付宝xxx」。
assert.equal(
  guessAlipayOwnerFromFilename("\u5f20\u56db.\u652f\u4ed8\u5b9d\u4ea4\u6613\u660e\u7ec6(20260728-20261028) .csv"),
  "\u5f20\u56db",
  "owner prefix in the filename must win over the bill content",
);
assert.equal(
  guessAlipayOwnerFromFilename("\u652f\u4ed8\u5b9d\u4ea4\u6613\u660e\u7ec6(20260728-20261028).csv"),
  "",
  "filename without an owner prefix must fall back to the bill content",
);
const renamed = normalizeAlipayWorkbookRows([{ sheetName: "alipay", rows: gbkRows }], "\u5f20\u56db");
assert.ok(renamed, "renamed bill must still hit the alipay template");
assert.equal(renamed.rows[1][5], "\u5f20\u56db\u652f\u4ed8\u5b9d\u82b1\u5457", "renamed bill must use the override owner");

// 9. 基金申购 / 理财按用户的转账口径入账：默认「资金账户 → 基金销售机构」，
//    只有卖出赎回 / 退款这类钱回来的才反向（转账的反向）。导出文件里没有基金代码，
//    基金名留在备注里，对向账户只能用交易对方（销售机构）。
//    例外：基金公司直接发过来的收益（余额宝每日益）是真进账，记收入。
const fundSheet = [{
  sheetName: "alipay",
  rows: [
    ...gbkRows.slice(0, gbkHeaderIndex),
    ["交易时间", "交易分类", "交易对方", "对方账号", "商品说明", "收/支", "金额", "收/付款方式", "交易状态", "交易订单号", "商家订单号", "备注"],
    ["2026-10-28 10:01:51", "投资理财", "蚂蚁财富-蚂蚁（杭州）基金销售有限公司", "/", "蚂蚁财富-示例全球配置混合(QDII)A-买入", "不计收支", "100.00", "余额宝", "付款成功，份额确认中", "20261028001080012204940034078796", "", ""],
    ["2026-10-28 02:48:47", "投资理财", "诺安基金管理有限公司", "/", "余额宝-2026.10.27-收益发放", "不计收支", "0.37", "余额宝", "交易成功", "20261028391342355941", "", ""],
    ["2026-10-13 09:12:00", "投资理财", "蚂蚁财富-蚂蚁（杭州）基金销售有限公司", "/", "蚂蚁财富-示例全球配置混合(QDII)C-卖出至余额宝", "不计收支", "15110.62", "余额宝", "交易成功", "20261013001080012204940000000001", "", ""],
  ],
}];
const fund = normalizeAlipayWorkbookRows(fundSheet);
assert.ok(fund, "fund bill must hit the alipay template");
assert.equal(fund.rows[1][1], "转账", "fund purchase must be a transfer");
assert.equal(fund.rows[1][2], "100", "fund purchase must be an outflow");
assert.equal(fund.rows[1][5], "测试用户支付宝余额宝", "fund purchase must debit the Yu'ebao account");
assert.equal(fund.rows[1][6], "蚂蚁财富-蚂蚁（杭州）基金销售有限公司", "fund purchase must credit the fund distributor");
assert.equal(fund.rows[2][1], "收入", "yu'ebao yield paid by the fund company must be income");
assert.equal(fund.rows[2][3], "0.37", "yu'ebao yield must be an inflow");
assert.equal(fund.rows[2][6], "", "income rows must not need a counter account");
assert.equal(fund.rows[2][5], "测试用户支付宝余额宝", "yield must land in the Yu'ebao account");
assert.equal(fund.rows[3][3], "15110.62", "fund sale must flow back into the funding account");

// 10. 支付宝账单里的基金买卖要能被抽出来，交给基金导入链路变成真正的买入 / 赎回。
assert.equal(
  extractAlipayFundName("\u8682\u8681\u8d22\u5bcc-\u6469\u6839\u6807\u666e500\u6307\u6570(QDII)A-\u4e70\u5165"),
  "\u6469\u6839\u6807\u666e500\u6307\u6570(QDII)A",
  "fund name must be carved out of the alipay product text",
);
// 份额后缀必须严格一致：A 类和 C 类是两只不同基金，不能串。
assert.deepEqual(splitFundShareClass("\u6469\u6839\u65e5\u672c\u7cbe\u9009\u80a1\u7968(QDII)C"), {
  core: "\u6469\u6839\u65e5\u672c\u7cbe\u9009\u80a1\u7968(QDII)",
  suffix: "C",
});
assert.equal(
  matchFundNameToCode(
    "\u6469\u6839\u65e5\u672c\u7cbe\u9009\u80a1\u7968(QDII)C",
    [{ fundCode: "007280", name: "\u6469\u6839\u65e5\u672c\u7cbe\u9009\u80a1\u7968(QDII)A" }],
  ),
  null,
  "different share classes must never match each other",
);
assert.equal(
  matchFundNameToCode(
    "\u5bcc\u56fd\u963f\u5c14\u6cd5\u4e24\u5e74\u6301\u6709\u671f\u6df7\u5408",
    [{ fundCode: "008372", name: "\u5bcc\u56fd\u963f\u5c14\u6cd5\u4e24\u5e74\u6301\u6709\u671f\u6df7\u5408" }],
  )?.fundCode,
  "008372",
  "exact fund name must resolve to the local fund code",
);

const fundBillRows = [
  ["\u5bfc\u51fa\u4fe1\u606f\uff1a"],
  ["\u59d3\u540d\uff1a\u6d4b\u8bd5\u7528\u6237"],
  ["\u4ea4\u6613\u65f6\u95f4", "\u4ea4\u6613\u5206\u7c7b", "\u4ea4\u6613\u5bf9\u65b9", "\u5bf9\u65b9\u8d26\u53f7", "\u5546\u54c1\u8bf4\u660e", "\u6536/\u652f", "\u91d1\u989d", "\u6536/\u4ed8\u6b3e\u65b9\u5f0f", "\u4ea4\u6613\u72b6\u6001", "\u4ea4\u6613\u8ba2\u5355\u53f7", "\u5546\u5bb6\u8ba2\u5355\u53f7", "\u5907\u6ce8"],
  ["2026-10-28 10:01:51", "\u6295\u8d44\u7406\u8d22", "\u8682\u8681\u8d22\u5bcc-\u8682\u8681\uff08\u676d\u5dde\uff09\u57fa\u91d1\u9500\u552e\u6709\u9650\u516c\u53f8", "/", "\u8682\u8681\u8d22\u5bcc-\u6469\u6839\u6807\u666e500\u6307\u6570(QDII)A-\u4e70\u5165", "\u4e0d\u8ba1\u6536\u652f", "10.00", "\u4f59\u989d\u5b9d", "\u4ed8\u6b3e\u6210\u529f\uff0c\u4efd\u989d\u786e\u8ba4\u4e2d", "1", "", ""],
  ["2026-10-09 17:04:07", "\u6295\u8d44\u7406\u8d22", "\u8682\u8681\u8d22\u5bcc-\u8682\u8681\uff08\u676d\u5dde\uff09\u57fa\u91d1\u9500\u552e\u6709\u9650\u516c\u53f8", "/", "\u8682\u8681\u8d22\u5bcc-\u6613\u65b9\u8fbe\u7eff\u8272\u7535\u529bETF\u8054\u63a5C-\u5356\u51fa\u81f3\u4f59\u989d\u5b9d", "\u4e0d\u8ba1\u6536\u652f", "20748.61", "\u4f59\u989d\u5b9d", "\u4ea4\u6613\u6210\u529f", "2", "", ""],
  // 提现和余额宝收益都不是基金买卖，必须留在普通流水里。
  ["2026-10-10 17:57:42", "\u6295\u8d44\u7406\u8d22", "\u62db\u5546\u94f6\u884c", "jia***@lionfund.com.cn", "\u4f59\u989d\u5b9d-\u8f6c\u51fa\u5230\u94f6\u884c\u5361", "\u4e0d\u8ba1\u6536\u652f", "20000.00", "\u62db\u5546\u94f6\u884c\u50a8\u84c4\u5361(2556)", "\u4ea4\u6613\u6210\u529f", "3", "", ""],
  ["2026-10-28 02:48:47", "\u6295\u8d44\u7406\u8d22", "\u8bfa\u5b89\u57fa\u91d1\u7ba1\u7406\u6709\u9650\u516c\u53f8", "/", "\u4f59\u989d\u5b9d-2026.10.27-\u6536\u76ca\u53d1\u653e", "\u4e0d\u8ba1\u6536\u652f", "0.37", "\u4f59\u989d\u5b9d", "\u4ea4\u6613\u6210\u529f", "4", "", ""],
];
const fundTrades = extractAlipayFundTrades([{ sheetName: "alipay", rows: fundBillRows }], "\u6d4b\u8bd5\u7528\u6237");
assert.equal(fundTrades.length, 2, "withdrawals and Yu'ebao yields must stay out of the fund channel");
assert.equal(fundTrades[0]?.date, "2026-10-28");
assert.equal(fundTrades[0]?.subtype, "buy");
assert.equal(fundTrades[0]?.fundName, "\u6469\u6839\u6807\u666e500\u6307\u6570(QDII)A");
assert.equal(fundTrades[0]?.cashAccount, "\u6d4b\u8bd5\u7528\u6237\u652f\u4ed8\u5b9d\u4f59\u989d\u5b9d");
assert.equal(fundTrades[0]?.fundAccount, "\u6d4b\u8bd5\u7528\u6237\u8682\u8681\u8d22\u5bcc\u57fa\u91d1");
assert.equal(fundTrades[1]?.subtype, "redeem");
assert.equal(fundTrades[1]?.amount, 20748.61);
// 抽取必须喂「原始行」：被支付宝模板归一化之后，列已经换成 MMH 标准列，
// 「商品说明 / 交易分类」这些判定依据没了，抽取结果会是 0 —— 批量导入页
// 就因为这个 bug 一直没能走进基金链路。
assert.equal(
  extractAlipayFundTrades(
    [{
      sheetName: "alipay",
      rows: normalizeAlipayWorkbookRows([{ sheetName: "alipay", rows: fundBillRows }], "\u6d4b\u8bd5\u7528\u6237")?.rows ?? [],
    }],
    "\u6d4b\u8bd5\u7528\u6237",
  ).length,
  0,
  "normalized bill rows carry no Alipay headers; the fund route must be fed raw rows",
);

// 10b. 同一张账单拆成两个页签：资金收支必须剔除已归入基金买卖的行，同一笔钱不能记两次。
assert.equal(
  excludeFundTradeRows(fundBillRows, fundTrades).length,
  fundBillRows.length - 2,
  "the cash-flow tab must drop exactly the rows handed over to the fund tab",
);

// 11. 名称反查的三重守卫：份额后缀、币种、基金公司前缀都必须一致。
//     基金全名只差「A / C」「人民币 / 美元现汇」就是两只不同基金，宁可留空。
assert.equal(
  pickFundSearchCandidate("X\u57fa\u91d1\u6df7\u5408A", [{ fundCode: "000001", name: "X\u57fa\u91d1\u6df7\u5408C" }]),
  null,
  "A share must never match a C share",
);
assert.equal(
  pickFundSearchCandidate("X\u57fa\u91d1\u6df7\u5408", [{ fundCode: "000002", name: "X\u57fa\u91d1\u6df7\u5408\u7f8e\u5143\u73b0\u6c47" }]),
  null,
  "CNY share must never match a USD-settlement share",
);
assert.equal(
  pickFundSearchCandidate("A\u516c\u53f8\u6df7\u5408", [{ fundCode: "000003", name: "B\u516c\u53f8\u6df7\u5408" }]),
  null,
  "different fund companies must never match",
);
// 账单「华商元亨灵活配置混合A」在本地库里写作「华商元亨混合A」——
// 只是多了「灵活配置」四个字，必须能认出来是同一只。
assert.equal(
  pickFundSearchCandidate(
    "\u534e\u5546\u5143\u4ea8\u7075\u6d3b\u914d\u7f6e\u6df7\u5408A",
    [{ fundCode: "004206", name: "\u534e\u5546\u5143\u4ea8\u6df7\u5408A" }],
  )?.fundCode,
  "004206",
  "an inserted qualifier like flexible-allocation must still resolve",
);

// 12. 账单文件的读取入口：CSV 一律走 decodeTextFile，绝不交给 XLSX.read
//     （SheetJS 对 CSV 按 cp1252 解码，会把「起始时间」读成「ÆðÊ¼Ê±¼ä」）。
assert.equal(
  isSpreadsheetWorkbookFile({ name: "\u6d4b\u8bd5\u7528\u6237.\u652f\u4ed8\u5b9d\u4ea4\u6613\u660e\u7ec6.csv" } as File),
  false,
  "a .csv bill must never be handed to XLSX.read (cp1252 decodes GBK into mojibake)",
);
assert.equal(
  isSpreadsheetWorkbookFile({ name: "\u660e\u7ec6.xlsx" } as File),
  true,
  "an .xlsx bill is a real workbook and must go through XLSX.read",
);
const billHeaderText = parseStatementCsv(gbkText).slice(0, 10).flat().join("\n");
assert.ok(billHeaderText.includes("\u8d77\u59cb\u65f6\u95f4"), "CSV bill header must decode the start-date line");
assert.ok(billHeaderText.includes("\u7ec8\u6b62\u65f6\u95f4"), "CSV bill header must decode the end-date line");
assert.ok(!/[Ã-ÿ£]/.test(billHeaderText), "CSV bill must not contain cp1252 mojibake of GBK bytes");

// 13. 源码里不得再用 file.text() 读账单 CSV：它按 UTF-8 解码 GBK 文件，必然乱码。
function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      collectSourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const offenders: string[] = [];
for (const file of collectSourceFiles(path.resolve(process.cwd(), "src"))) {
  const source = fs.readFileSync(file, "utf8");
  if (/parseCsv\(\s*await\s+[\w.]*\.text\(\)/.test(source)) {
    offenders.push(path.relative(process.cwd(), file));
  }
}
assert.deepEqual(
  offenders,
  [],
  "bill CSV must be read through decodeTextFile (GBK), not file.text()",
);

console.log("check:csv-import ok");
