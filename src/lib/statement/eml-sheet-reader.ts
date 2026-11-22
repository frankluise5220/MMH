/**
 * .eml 邮件账单 → 工作表行（浏览器/Node 通用，纯 TextDecoder + 正则，不依赖 Buffer/DOMParser）。
 *
 * 中国石化加油卡等邮件账单把明细放在正文 HTML 的 <table> 里，正文常是 quoted-printable。
 * 直接按 CSV 读 eml 只会得到邮件头和乱码标签，识别器自然找不到表头。
 * 本模块把邮件正文解开、按 <h2> 标题提取「交易信息」「付费信息」等表格，
 * 输出与 xlsx 一致的 string[][]（每个表一个 sheet），交给现有账单识别管线。
 */

export type EmlSheet = { sheetName: string; rows: string[][] };

/** quoted-printable 解码：=XX 还原字节、=\r?\n 是软换行，解码后的字节按 UTF-8 读。 */
function decodeQuotedPrintable(raw: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(raw.slice(i + 1, i + 3))) {
      bytes.push(parseInt(raw.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (ch === "=" && (raw[i + 1] === "\r" || raw[i + 1] === "\n")) {
      if (raw[i + 1] === "\r" && raw[i + 2] === "\n") i += 2;
      else i += 1;
    } else {
      // latin1 单字节映射：文件已按 latin1 读，每个 charCode 就是一个原始字节。
      bytes.push(ch.charCodeAt(0) & 0xff);
    }
  }
  return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
}

/** 邮件正文可能是 quoted-printable（带 =XX）或 base64，也可能是明文。 */
function decodeBody(raw: string, transferEncoding: string): string {
  const encoding = transferEncoding.trim().toLowerCase();
  if (encoding === "quoted-printable" || /=([0-9A-Fa-f]{2})/.test(raw.slice(0, 4000))) {
    return decodeQuotedPrintable(raw);
  }
  return raw;
}

function stripTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, "")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .trim();
}

function extractTableAfterHeading(body: string, heading: string): string[][] | null {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const h2 = body.match(new RegExp(`<h2[^>]*>\\s*${escaped}\\s*</h2>`));
  if (!h2 || h2.index === undefined) return null;
  const after = body.slice(h2.index + h2[0].length);
  const tables: string[] = [];
  let from = 0;
  while (tables.length < 8) {
    const start = after.indexOf("<table", from);
    if (start < 0) break;
    const end = after.indexOf("</table>", start);
    if (end < 0) break;
    tables.push(after.slice(start, end + 8));
    from = end + 8;
  }
  if (!tables.length) return null;

  const tableRows = tables.map((html) => {
    const rows: string[][] = [];
    for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells: string[] = [];
      for (const td of tr[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)) cells.push(stripTags(td[1]));
      if (cells.some(Boolean)) rows.push(cells);
    }
    return rows;
  });

  // 表头：含「时间/日期」字样的那一行。
  let header: string[] | null = null;
  for (const rows of tableRows) {
    const candidate = rows.find((r) => r.some((c) => /时间|日期/.test(c)));
    if (candidate && candidate.length >= 3) { header = candidate; break; }
  }
  if (!header) return null;
  const width = header.length;
  const result: string[][] = [header];
  const seen = new Set<string>();
  for (const rows of tableRows) {
    for (const r of rows) {
      if (r === header) continue;
      if (r.some((c) => /小计|总计|合计|卡号：|圈存|圈提|奖励积分/.test(c))) continue;
      if (r.length < width / 2) continue;
      if (!r.some((c) => /^\d{4}[-\/]\d{1,2}[-\/]\d{1,2}/.test(c))) continue;
      const key = r.join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(r);
    }
  }
  return result.length > 1 ? result : null;
}

/** 从 .eml 原始文本（按 latin1 读成每字节一个 char）里取正文 HTML 并提取表格。 */
export function parseEmlSheets(rawLatin1: string): EmlSheet[] {
  // 取 Content-Transfer-Encoding；邮件头与正文用空行分隔。
  const headerEnd = rawLatin1.search(/\r?\n\r?\n/);
  const head = headerEnd >= 0 ? rawLatin1.slice(0, headerEnd) : rawLatin1.slice(0, 2000);
  const encodingMatch = head.match(/Content-Transfer-Encoding\s*:\s*([^\r\n]+)/i);
  const transferEncoding = encodingMatch?.[1] ?? "";
  let body = decodeBody(rawLatin1, transferEncoding);
  // 若仍是 quoted-printable 片段（multipart 各段头里各自声明），再兜底解一次。
  if (/=([0-9A-Fa-f]{2})/.test(body.slice(0, 2000))) body = decodeQuotedPrintable(body);

  const htmlStart = body.search(/<(html|body|table|div|h2)\b/i);
  return parseHtmlSheets(htmlStart >= 0 ? body.slice(htmlStart) : body);
}

/** 从已解码的邮件 HTML 字符串里提取表格（邮箱链路 mail.html 已由 mailparser 解码）。 */
export function parseHtmlSheets(html: string): EmlSheet[] {
  const sheets: EmlSheet[] = [];
  // 优先按 h2 标题提取已知中石化表格；同时兜底抓所有含日期列的表格。
  const headings = Array.from(html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)).map((m) => stripTags(m[1])).filter(Boolean);
  for (const heading of headings) {
    const table = extractTableAfterHeading(html, heading);
    if (table) sheets.push({ sheetName: heading, rows: table });
  }
  if (sheets.length === 0) {
    // 未知邮件：把正文里所有表格依次作为 sheet，交给通用识别器判定。
    let from = 0;
    let index = 1;
    while (from < html.length) {
      const start = html.indexOf("<table", from);
      if (start < 0) break;
      const end = html.indexOf("</table>", start);
      if (end < 0) break;
      const rows: string[][] = [];
      const tableHtml = html.slice(start, end + 8);
      for (const tr of tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
        const cells: string[] = [];
        for (const td of tr[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)) cells.push(stripTags(td[1]));
        if (cells.some(Boolean)) rows.push(cells);
      }
      if (rows.length > 1) sheets.push({ sheetName: `Sheet${index++}`, rows });
      from = end + 8;
    }
  }
  return sheets;
}
