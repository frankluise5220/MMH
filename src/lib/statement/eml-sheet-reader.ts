/**
 * .eml 邮件账单 → 工作表行（浏览器/Node 通用，纯 TextDecoder + 正则，不依赖 Buffer/DOMParser）。
 *
 * 邮件账单把明细放在正文 HTML 的 <table> 里，正文常是 quoted-printable 或 base64
 * （农行金穗信用卡整篇正文都是 base64，且 Content-Type 的 charset 为空）。
 * 直接按 CSV 读 eml 只会得到邮件头和乱码标签，识别器自然找不到表头。
 * 本模块把邮件正文解开（含编码探测）、按 <h2> 标题或叶子表格提取明细表，
 * 输出与 xlsx 一致的 string[][]（每个表一个 sheet），交给现有账单识别管线。
 */

export type EmlSheet = { sheetName: string; rows: string[][] };

/** 邮件正文 HTML 的 sheet 名：这类 sheet 只有一行（整篇 HTML），不参与模板识别，只用来还原 text。 */
export const EML_HTML_SHEET_NAME = "邮件正文";

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64ToBytes(input: string): Uint8Array {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of input) {
    if (ch === "=") break;
    const value = BASE64_ALPHABET.indexOf(ch);
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
      // 只留未消费的低位，否则 buffer 会一路左移溢出，解出来的字节全是垃圾。
      buffer &= (1 << bits) - 1;
    }
  }
  return new Uint8Array(out);
}

/**
 * 字节 → 字符串：先按邮件头声明的 charset，再按 UTF-8 严格、GB18030 依次探测。
 * 农行账单头写的是 `charset=""`（空），只能靠探测，否则整篇中文变乱码。
 */
function decodeBytes(bytes: Uint8Array, charset: string): string {
  const declared = charset.trim().toLowerCase().replace(/^["']|["']$/g, "");
  const candidates: string[] = [];
  if (declared && !/^(unknown|default|us-ascii|ascii)$/.test(declared)) {
    candidates.push(/gb|big5|euc/i.test(declared) ? (/big5/i.test(declared) ? "big5" : "gbk") : declared);
  }
  candidates.push("utf-8", "gb18030", "gbk");
  for (const candidate of candidates) {
    try {
      return new TextDecoder(candidate, { fatal: true }).decode(bytes);
    } catch {
      // 换下一种编码
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/** quoted-printable 解码：=XX 还原字节、=\r?\n 是软换行，解码后的字节按声明/探测编码读。 */
function decodeQuotedPrintable(raw: string, charset: string): string {
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
  return decodeBytes(new Uint8Array(bytes), charset);
}

/** 邮件正文可能是 base64、quoted-printable（带 =XX），也可能是明文。 */
function decodeBody(raw: string, transferEncoding: string, charset: string): string {
  const encoding = transferEncoding.trim().toLowerCase();
  if (encoding.includes("base64")) {
    const bytes = base64ToBytes(raw);
    // 头部 charset 常写成 charset=""（农行），退而看正文 HTML 自己的 <meta charset=gbk>。
    const sniffed = charset || new TextDecoder("latin1").decode(bytes.slice(0, 2000)).match(/charset\s*=\s*"?([\w-]+)/i)?.[1] || "";
    return decodeBytes(bytes, sniffed);
  }
  if (encoding.includes("quoted-printable") || /=([0-9A-Fa-f]{2})/.test(raw.slice(0, 4000))) {
    return decodeQuotedPrintable(raw, charset);
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

type TableSlice = { start: number; end: number; html: string; nested: number };

/**
 * 把 HTML 里所有 <table> 按嵌套深度配对，返回「含内层表的完整外层表」。
 * 银行账单邮件普遍用 table 做布局（农行一封里有 290+ 个 table），
 * 用 indexOf("</table>") 会在内层结束时提前截断，明细行全丢。
 */
function collectTables(html: string): TableSlice[] {
  const tagRe = /<\/?table\b[^>]*>/gi;
  const stack: Array<{ start: number; nested: number }> = [];
  const tables: TableSlice[] = [];
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html))) {
    if (match[0][1] === "/") {
      const open = stack.pop();
      if (!open) continue;
      const end = match.index + match[0].length;
      tables.push({ start: open.start, end, nested: open.nested, html: html.slice(open.start, end) });
    } else {
      for (const item of stack) item.nested += 1;
      stack.push({ start: match.index, nested: 0 });
    }
  }
  return tables.sort((a, b) => a.start - b.start);
}

function tableRows(tableHtml: string): string[][] {
  const rows: string[][] = [];
  for (const tr of tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells: string[] = [];
    for (const td of tr[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)) cells.push(stripTags(td[1]));
    if (cells.some(Boolean)) rows.push(cells);
  }
  return rows;
}

/** 一张表是否像「明细表」：≥2 行、至少一行含日期/金额形态的单元格。 */
function looksLikeDetailTable(rows: string[][]): boolean {
  if (rows.length < 2) return false;
  return rows.some(
    (row) =>
      row.some((cell) => /^\d{4}[-\/年]\d{1,2}[-\/月]\d{1,2}/.test(cell) || /^\d{1,2}[-\/]\d{1,2}$/.test(cell)) ||
      row.filter((cell) => /^-?\d[\d,]*\.\d{2}$/.test(cell)).length >= 2,
  );
}

function extractTableAfterHeading(body: string, heading: string): string[][] | null {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const h2 = body.match(new RegExp(`<h2[^>]*>\\s*${escaped}\\s*</h2>`));
  if (!h2 || h2.index === undefined) return null;
  const headingEnd = h2.index + h2[0].length;
  // 标题之后连续出现的表（含内层表）共同组成这张明细，取前 8 张足够。
  const tables = collectTables(body)
    .filter((table) => table.start >= headingEnd)
    .slice(0, 8)
    .map((table) => tableRows(table.html));
  if (!tables.length) return null;

  // 表头：含「时间/日期」字样的那一行。
  let header: string[] | null = null;
  for (const rows of tables) {
    const candidate = rows.find((r) => r.some((c) => /时间|日期/.test(c)));
    if (candidate && candidate.length >= 3) {
      header = candidate;
      break;
    }
  }
  if (!header) return null;
  const width = header.length;
  const result: string[][] = [header];
  const seen = new Set<string>();
  for (const rows of tables) {
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

/**
 * 邮件头字段（Content-Transfer-Encoding / charset）与正文起点。
 *
 * 不能只认「第一个空行」：SoHu/QQ 归档的邮件在 Return-Path 之后会多插一个空行，
 * 那样只能读到两行头，Content-Transfer-Encoding 永远取不到（农行整篇 base64 会漏解）。
 * 这里在开头 20KB 内找最后一次出现的该字段，正文从它后面第一个空行开始。
 */
function readMailHeaders(rawLatin1: string) {
  const scan = rawLatin1.slice(0, Math.min(rawLatin1.length, 20000));
  const encodings = [...scan.matchAll(/^Content-Transfer-Encoding\s*:\s*([^\r\n]+)/gim)];
  const encoding = encodings.length ? encodings[encodings.length - 1][1] : "";
  const charset = scan.match(/charset\s*=\s*"?([\w-]*)"?/i)?.[1] ?? "";
  let headerEnd = rawLatin1.search(/\r?\n\r?\n/);
  if (encodings.length) {
    const last = encodings[encodings.length - 1];
    const after = (last.index ?? 0) + last[0].length;
    // 该字段之后还可能跟着别的头（如 SoHu 的 X-Sohu-Gateway），正文要从那一段头结束的空行算起。
    const separator = rawLatin1.slice(after).match(/\r?\n\r?\n/);
    headerEnd = separator ? after + (separator.index ?? 0) + separator[0].length : after;
  }
  return { headerEnd, encoding, charset };
}

/** 邮件正文解码后的 HTML/纯文本（已按 base64 / quoted-printable 与编码探测还原）。 */
export function parseEmlBody(rawLatin1: string): string {
  const { headerEnd, encoding, charset } = readMailHeaders(rawLatin1);
  const bodyRaw = headerEnd > 0 ? rawLatin1.slice(headerEnd) : rawLatin1;
  let body = decodeBody(bodyRaw, encoding, charset);
  // 若仍是 quoted-printable 片段（multipart 各段头里各自声明），再兜底解一次。
  // 只在「没有按 base64 解过」时才做，否则会把 HTML 里的 =3D 之类二次破坏。
  if (!encoding.trim().toLowerCase().includes("base64") && /=([0-9A-Fa-f]{2})/.test(body.slice(0, 2000))) {
    body = decodeQuotedPrintable(body, charset);
  }
  return body;
}

/** 解码后的正文 HTML 片段（跳过多余的纯文本前缀）。 */
export function emlBodyHtml(rawLatin1: string): string {
  const body = parseEmlBody(rawLatin1);
  const htmlStart = body.search(/<(html|body|table|div|h2)\b/i);
  return (htmlStart >= 0 ? body.slice(htmlStart) : body).trim();
}

/** 从 .eml 原始文本（按 latin1 读成每字节一个 char）里取正文 HTML 并提取表格。 */
export function parseEmlSheets(rawLatin1: string): EmlSheet[] {
  return parseHtmlSheets(emlBodyHtml(rawLatin1));
}

/** 从已解码的邮件 HTML 字符串里提取表格（邮箱链路 mail.html 已由 mailparser 解码）。 */
export function parseHtmlSheets(html: string): EmlSheet[] {
  const sheets: EmlSheet[] = [];
  // 优先按 h2 标题提取已知表格（中国石化等）；同时兜底抓所有叶子表格。
  const headings = Array.from(html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi))
    .map((m) => stripTags(m[1]))
    .filter(Boolean);
  for (const heading of headings) {
    const table = extractTableAfterHeading(html, heading);
    if (table) sheets.push({ sheetName: heading, rows: table });
  }
  if (sheets.length > 0) return sheets;

  // 未知邮件：只有「叶子表格」（内部不再嵌套 table）才可能是一张明细表；
  // 外层布局表会把整页包进去，取它会得到全页文本。另外要求表里出现日期/金额，
  // 避免把「点此查看账单」这类通知邮件的按钮表格当成明细。
  let index = 1;
  for (const table of collectTables(html)) {
    if (sheets.length >= 20) break;
    if (table.nested > 0) continue;
    const rows = tableRows(table.html);
    if (!looksLikeDetailTable(rows)) continue;
    sheets.push({ sheetName: `Sheet${index++}`, rows });
  }
  return sheets;
}
