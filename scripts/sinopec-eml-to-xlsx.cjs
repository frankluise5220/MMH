/**
 * 中国石化加油卡账单邮件（.eml）→ 可导入 xlsx。
 * 从 quoted-printable 的正文中提取「交易信息」11 列表和「付费信息」5 列表，
 * 保留 eml 原始表头与全部字段（升数/单价/地点/油品/积分等），交给 sinopec 识别器。
 *
 * 用法：node scripts/sinopec-eml-to-xlsx.cjs <eml路径> [输出xlsx路径]
 */
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");

function decodeQuotedPrintable(raw) {
  const bytes = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(raw.slice(i + 1, i + 3))) {
      bytes.push(parseInt(raw.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (raw[i] === "=" && (raw[i + 1] === "\r" || raw[i + 1] === "\n")) {
      if (raw[i + 1] === "\r" && raw[i + 2] === "\n") i += 2;
      else i += 1;
    } else {
      bytes.push(raw.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, "").replace(/&amp;/g, "&").trim();
}

/** 取 <h2>标题</h2> 之后连续 <table> 的表头行 + 数据行；跳过小计/总计，数据行来自内层独立表。 */
function extractTableAfterHeading(body, heading) {
  const h2 = body.match(new RegExp(`<h2[^>]*>\\s*${heading}\\s*</h2>`));
  if (!h2) return null;
  const after = body.slice(h2.index + h2[0].length);
  const tables = [];
  let searchFrom = 0;
  while (tables.length < 8) {
    const start = after.indexOf("<table", searchFrom);
    if (start < 0) break;
    const end = after.indexOf("</table>", start);
    if (end < 0) break;
    tables.push(after.slice(start, end + 8));
    searchFrom = end + 8;
  }
  if (!tables.length) return null;
  const tableRows = tables.map((html) => {
    const rows = [];
    for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells = [];
      for (const td of tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)) cells.push(stripTags(td[1]));
      if (cells.some(Boolean)) rows.push(cells);
    }
    return rows;
  });
  // 表头：含日期关键字的那一行（交易信息=交易时间，付费信息=付费时间）。
  let header = null;
  for (const rows of tableRows) {
    const candidate = rows.find((r) => r.some((c) => /时间/.test(c)));
    if (candidate && candidate.length >= 4) { header = candidate; break; }
  }
  if (!header) return null;
  const width = header.length;
  const result = [header];
  const seen = new Set();
  for (const rows of tableRows) {
    for (const r of rows) {
      if (r === header) continue;
      if (r.some((c) => /小计|总计|合计|卡号：|圈存|圈提|奖励积分/.test(c))) continue;
      // 数据行含日期（交易时间/付费时间形如 2024-01-02 ...），且不短于表头一半。
      if (r.length < width / 2) continue;
      if (!r.some((c) => /^\d{4}-\d{1,2}-\d{1,2}/.test(c))) continue;
      const key = r.join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(r);
    }
  }
  return result.length > 1 ? result : null;
}

function main() {
  const emlPath = process.argv[2] || "e:/fs/wiseme/.mh8/中国石化加油卡对账单.eml";
  const outPath = process.argv[3] || path.join(path.dirname(emlPath), "中石化加油卡_账单导入_2024-01.xlsx");
  const raw = fs.readFileSync(emlPath, "latin1");
  const body = decodeQuotedPrintable(raw);

  const trade = extractTableAfterHeading(body, "交易信息");
  const payment = extractTableAfterHeading(body, "付费信息");
  if (process.env.SINOPEC_DEBUG) {
    console.log("DEBUG trade:", JSON.stringify(trade));
    console.log("DEBUG payment:", JSON.stringify(payment));
  }
  if (!trade && !payment) throw new Error("未找到交易信息/付费信息表");

  const wb = XLSX.utils.book_new();
  if (trade) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(trade), "交易信息");
    console.log(`交易信息: ${trade.length - 1} 行 x ${trade[0].length} 列`);
  }
  if (payment) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(payment), "付费信息");
    console.log(`付费信息: ${payment.length - 1} 行 x ${payment[0].length} 列`);
  }
  XLSX.writeFile(wb, outPath, { compression: true });
  console.log("输出:", outPath);
}

main();
