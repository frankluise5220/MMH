import type { PDFParse as PDFParseInstance } from "pdf-parse";

import { STATEMENT_IMPORT_FIELD_HEADERS } from "../statement/header-catalog";
import { installPdfCanvasShim } from "./pdf-canvas-shim";

/**
 * pdf-parse 2.x 的 API 与 1.x 完全不同：没有默认导出，必须 `new PDFParse(...)`，
 * 并且要显式 `destroy()` 释放 pdfjs worker。旧代码按 1.x 调用（`mod.default`），
 * 在 2.4.5 下会抛 "parsePdf is not a function"，被上层的 catch 吞成
 * "PDF 文字提取失败"，导致邮箱里的 PDF 附件一条都抽不出文字。
 *
 * 这里保持动态 import：pdf-parse 的入口会加载 pdfjs 与可选的原生 canvas，
 * 改成静态 import 会把它绑进 imap-client 的模块图，webpack 编译期一旦解析不了
 * 原生二进制，整个邮件接口（连列表接口）都会返回 HTML 错误页。
 */

export type PdfExtractResult = {
  /** 文字层抽取结果；为空说明 PDF 没有文字层（扫描件 / 纯图片）。 */
  text: string;
  /** 按页检测到的表格：页 → 表 → 行 → 单元格。 */
  tables: string[][][];
  pageCount: number;
  /** 是否抽到了文字层。 */
  hasTextLayer: boolean;
  /** 解析过程中的异常消息；null 表示解析本身没报错（只是没内容）。 */
  error: string | null;
  /**
   * PDF 设了打开密码（未提供密码或密码错误）。
   *
   * 农商行这类银行的电子流水 PDF 默认加密，密码只在手机 App 的「交易流水打印 →
   * 申请记录」里显示，用户不输密码就永远抽不出文字。这里必须把「加密」与
   * 「扫描件 / 解析失败」区分开，否则界面只能给出「没有文字层」这种误导提示。
   */
  passwordRequired: boolean;
  /** 提供了密码但不对（passwordRequired=true 的子集，用于提示「密码不正确」）。 */
  passwordIncorrect: boolean;
  /**
   * PDF 确实加密了，但 pdfjs 不认这种加密方式（与密码无关）。
   *
   * 这时再让用户输密码没有意义，必须提示「用阅读器打开后另存 / 打印为 PDF 去掉加密」。
   */
  encryptionUnsupported: boolean;
};

const PAGE_JOINER = "\n";

const EMPTY_RESULT: PdfExtractResult = {
  text: "",
  tables: [],
  pageCount: 0,
  hasTextLayer: false,
  error: null,
  passwordRequired: false,
  passwordIncorrect: false,
  encryptionUnsupported: false,
};

/**
 * 把 pdfjs 的报错分成「密码问题」与「加密方式不认」两类。
 *
 * pdfjs 打不开加密 PDF 有两种完全不同的原因，混成一句「解析失败」会误导用户
 * （尤其是农商行流水这种默认加密的文件，用户会以为少弹了密码框）：
 *
 * - 密码问题：`No password given` / `Incorrect Password` —— 补密码就能解开；
 * - 加密方式不认：`unsupported encryption algorithm` / `unknown encryption method` /
 *   `Unknown crypto method` / `Invalid crypt filter name` —— 这是
 *   `CipherTransformFactory` 在**读取加密字典时就抛的**，跟用户输不输密码无关，
 *   补密码也没用，只能用 PDF 阅读器另存 / 打印为未加密 PDF 再导入。
 */
export function classifyPdfParseError(message: string) {
  const passwordRequired = /password/i.test(message);
  return {
    passwordRequired,
    passwordIncorrect: passwordRequired && /incorrect password|wrong password/i.test(message),
    encryptionUnsupported: !passwordRequired && /encrypt|crypto method|crypt filter/i.test(message),
  };
}

/**
 * 农商行这类电子流水的文字层是**乱序**的（PDF 内容流顺序与视觉列无关）：
 *
 * ```
 * 20241128 09:28:40苏KF17907原
 * 49.31元
 * 2024-11-29 10:03:27 0	49.31
 * ```
 *
 * 按行读会把备注里的 `苏KF17907` 当成金额 17907，还会给「49.31元」这种半行
 * 造一条假记录。它的 `getTable()` 结果是干净的 4 列（交易时间 / 收入支出金额 /
 * 商户类型 / 备注），所以只要有可用的流水表格，就优先用表格生成规范 TSV，
 * 让下游按表头取列，而不是猜「行内最后一个数字是金额」。
 */

/**
 * PDF 每页页脚（`江苏扬州农村商业银行2026-11-24 19:05:12`）会被 pdf-parse
 * 拼进单元格，还会被列宽切断成「江苏扬州农村商业」散落在相邻单元格里（截断位置
 * 在头、在尾、在中间都可能）。水印名是同一份文件里固定出现的，用「时间戳前缀」
 * 反推出水印名，再把它的所有 ≥5 字子串都当残片清洗，避免硬编码某家银行的名字。
 */
function learnFooterFragments(text: string) {
  const fragments = new Set<string>();
  for (const match of text.matchAll(/([^\s\d]{2,24})(?=\d{4}[-/]\d{1,2}[-/]\d{1,2}\s*\d{1,2}:\d{2})/g)) {
    const run = match[1].match(/[\u4e00-\u9fa5]+$/)?.[0] ?? "";
    for (let start = 0; start <= run.length - 5; start += 1) {
      for (let end = start + 5; end <= run.length; end += 1) fragments.add(run.slice(start, end));
    }
  }
  return [...fragments].sort((a, b) => b.length - a.length);
}

function cleanTableCell(value: string, fragments: string[]) {
  let out = String(value ?? "");
  // ① 机构名 + 时间戳整段是页脚：要求机构名是 ≥2 个汉字，否则会把单元格里那个
  //    `2024-11-25 23:08:20` 交易时间当成页脚一起删掉。
  //    还要求这段汉字与学到水印名有重叠——否则「京东商城业务2026-11-24 19:05:12」
  //    这种「商户名 + 日期」的备注会被当成页脚整段删掉（那是丢数据，不是清洗）。
  out = out.replace(
    /[\u4e00-\u9fa5]{2,24}\d{4}[-/]\d{1,2}[-/]\d{1,2}\s*\d{1,2}:\d{2}(?::\d{2})?/g,
    (match) => {
      const name = match.match(/^[\u4e00-\u9fa5]+/)?.[0] ?? "";
      const isFooter = fragments.some(
        (fragment) => fragment.length >= 5 && (name.includes(fragment) || fragment.includes(name)),
      );
      return isFooter ? " " : match;
    },
  );
  // ② 被切断的水印残片（「江苏扬州农村商业」），按学到的名字删除。
  for (const fragment of fragments) out = out.split(fragment).join(" ");
  return out
    .split(/\r?\n/)
    // ③ 页脚日期被切到备注尾巴上（`…京东商城业务2026-11-24`）：只削掉日期，留下商户名；
    //    单独的日期单元格（前面没有内容）保持原样，那是交易时间。
    .map((line) => line
      .replace(/(?<=.)([\u4e00-\u9fa5]*?)\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:\s*\d{1,2}:\d{2}(?::\d{2})?)?\s*$/g, "$1")
      .replace(/\s+/g, " ")
      .trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

type PdfStatementColumns = {
  date: number;
  /** 合并金额列（正=支出、负=入账）；「收入」「支出」分列时为 -1。 */
  amount: number;
  inflow: number;
  outflow: number;
};

function pdfStatementColumns(cells: string[]): PdfStatementColumns | null {
  const normalized = cells.map((cell) => cell.replace(/\s+/g, ""));
  const dated = normalized.findIndex((cell) => /(?:交易|记账|入账|到账|发生).*(?:日期|时间)/.test(cell));
  const date = dated >= 0 ? dated : normalized.findIndex((cell) => /日期|时间/.test(cell));
  if (date < 0) return null;

  // 「收入/支出金额」是合并列，先于收入、支出分列判断。
  const merged = normalized.findIndex((cell) => /金额|发生额/.test(cell)
    && /收入|入账|贷方/.test(cell) && /支出|出账|借方/.test(cell));
  const moneyCell = (patterns: RegExp[]) => normalized.findIndex((cell) => /金额|发生额/.test(cell)
    && !/余额|额度|可用/.test(cell) && patterns.some((pattern) => pattern.test(cell)));

  const outflow = merged >= 0 ? -1 : moneyCell([/支出|流出|借方/]);
  const inflow = merged >= 0 ? -1 : moneyCell([/收入|流入|贷方/]);
  const amount = merged >= 0
    ? merged
    : normalized.findIndex((cell, index) => index !== outflow && index !== inflow
      && /金额|发生额/.test(cell) && !/余额|额度|可用/.test(cell));
  if (amount < 0 && inflow < 0 && outflow < 0) return null;
  return { date, amount, inflow, outflow };
}

/** 单元格金额：容忍千分位与括号负数；空、「-」、「0」都返回 null（不是有效金额）。 */
function pdfStatementAmount(value: string) {
  const normalized = String(value ?? "").replace(/[,\s￥¥元]/g, "").trim();
  if (!normalized || !/\d/.test(normalized)) return null;
  const negative = /^[-−(（]/.test(normalized) || /[)）]$/.test(normalized);
  const digits = normalized.match(/\d+(?:\.\d+)?/);
  if (!digits) return null;
  const parsed = Number(digits[0]);
  if (!Number.isFinite(parsed) || parsed === 0) return null;
  return negative ? -parsed : parsed;
}

function pdfRowAmount(cells: string[], columns: PdfStatementColumns) {
  if (columns.amount >= 0) return pdfStatementAmount(cells[columns.amount] ?? "");
  const outflow = columns.outflow >= 0 ? pdfStatementAmount(cells[columns.outflow] ?? "") : null;
  if (outflow) return outflow;
  const inflow = columns.inflow >= 0 ? pdfStatementAmount(cells[columns.inflow] ?? "") : null;
  return inflow ? Math.abs(inflow) : null;
}

/**
 * 页眉里的开户卡号线索。农商行流水的页眉写着 `6228 **** 2058`，它落在表格
 * 单元格之外，表格优先路径会把整行丢掉——于是 96 条流水都没有账户，预览里
 * 只能逐条手选。这里只认「掩码卡号」这种明确写法（≥2 个掩码字符夹住首尾），
 * 备注里偶尔出现的四位数字（`尾号2058`、`苏KF17907`）不算。
 */
function learnAccountHint(text: string) {
  const masked = [...text.matchAll(/(\d{2,6})[\s*＊xX·•]{2,}\s*(\d{4})(?!\d)/g)];
  const last = masked.at(-1);
  return last ? `尾号${last[2]}` : "";
}

/** 表头里是否已经自带账户列（别名口径与标准模板一致，避免重复追加）。 */
function layoutHasAccountColumn(cells: string[]) {
  const keys = cells.map((cell) => cell.replace(/\s+/g, ""));
  return keys.some((key) => STATEMENT_IMPORT_FIELD_HEADERS.sourceAccount.some((alias) => key === alias));
}

/**
 * 信用卡账单的文字层里一定带账单摘要（本期应还 / 最低应还 / 额度 / 账单日 /
 * 到期还款日）。这类 PDF 有专用模板按原始排版解析，还要靠摘要锁定账期、补账户
 * 档案。表格接管会把 text 换成 4 列 TSV，专用模板再也看不到摘要 —— 那是拿新功能
 * 覆盖旧功能。命中摘要时一律不接管，让原文继续走原来的信用卡链路。
 */
function hasCreditCardStatementSummary(text: string) {
  return /本期应还|最低应还|信用额度|账单日|到期还款日|账单月份|上期账单/.test(text);
}

/**
 * 表格 → 规范 TSV（首行表头）。表格不像流水（找不到日期+金额表头，或金额列
 * 解析不出来的行太多）时返回 null，交给原来的文字流链路。
 *
 * 导出仅为让 `npm run check:recognizer` 能用合成表格覆盖水印清洗与列裁剪；
 * 业务代码请走 `extractPdfContent`，不要绕过它自己调表格。
 */
export function buildStatementTableText(tables: string[][][], text: string) {
  // 信用卡账单：正文本身可解析，且摘要（本期应还/账单日/额度）只在原文里。
  if (hasCreditCardStatementSummary(text)) return null;
  const fragments = learnFooterFragments(text);
  const accountHint = learnAccountHint(text);
  let appendAccountColumn = false;
  let columns: PdfStatementColumns | null = null;
  let header: string[] = [];
  const rows: string[][] = [];

  for (const table of tables) {
    for (const row of table) {
      const cells = row.map((cell) => cleanTableCell(cell, fragments));
      if (!cells.some(Boolean)) continue;
      const layout = pdfStatementColumns(cells);
      if (!columns) {
        // 表格前的标题行没有表头，跳过直到第一行表头。
        if (!layout) continue;
        columns = layout;
        // 表里没有账户列、页眉却有卡号尾号时补一列「账户」：下游标准模板按别名取值，
        // 预览就能靠尾号匹配到已有账户（`尾号2058` → 京东联名），不用 96 条手选。
        appendAccountColumn = Boolean(accountHint) && !layoutHasAccountColumn(cells);
        header = appendAccountColumn ? [...cells, "账户"] : cells;
        continue;
      }
      // 每页重复的表头不再当作数据行。
      if (layout) continue;
      const padded = header.map((_, index) => cells[index] ?? "");
      if (appendAccountColumn) padded[padded.length - 1] = accountHint;
      // 金额列取不出数的行（合计、说明、页脚）不是流水，丢掉。
      if (!pdfRowAmount(padded, columns)) continue;
      rows.push(padded);
    }
  }

  if (!columns || header.length < 2 || rows.length < 3) return null;
  // 日期列必须真的是日期，避免把「合计/小计」这类汇总行当流水。
  const dateIndex = columns.date;
  const datedRows = rows.filter((cells) => /^\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}/.test((cells[dateIndex] ?? "").trim()));
  if (datedRows.length / rows.length < 0.8) return null;

  return [header.join("\t"), ...rows.map((cells) => cells.join("\t"))].join("\n");
}

/** 表格按单元格拼成文本，供没有排版信息的识别链路兜底（同样削掉页脚水印）。 */
function tablesToText(tables: string[][][], text: string) {
  const fragments = learnFooterFragments(text);
  return tables
    .map((rows) => rows
      .map((cells) => cells.map((cell) => cleanTableCell(cell, fragments)).join("\t"))
      .filter((line) => line.trim().length > 0)
      .join("\n"))
    .filter((block) => block.trim().length > 0)
    .join("\n\n");
}

function normalizeText(value: unknown) {
  return String(value ?? "").replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "");
}

export async function extractPdfContent(
  content: Buffer,
  options: { password?: string } = {},
): Promise<PdfExtractResult> {
  if (!content.length) return { ...EMPTY_RESULT };
  const password = (options.password ?? "").trim();

  let parser: PDFParseInstance | null = null;
  try {
    // 必须在 pdfjs（含它的 fake worker）首次加载前装好：没有原生 canvas 时 pdfjs
    // 会在图片蒙版描边路径上 `new DOMMatrix()`，缺了这个符号所有 PDF 都解析不了。
    installPdfCanvasShim();
    const { PDFParse } = await import("pdf-parse");
    // 传副本，避免 worker 的 transfer 把调用方的 Buffer 挪走。
    parser = new PDFParse({
      data: new Uint8Array(content),
      ...(password ? { password } : {}),
    } as ConstructorParameters<typeof PDFParse>[0]);

    let pageCount = 0;
    let text = "";
    try {
      const textResult = await parser.getText({ pageJoiner: PAGE_JOINER });
      pageCount = textResult.pages?.length ?? 0;
      text = normalizeText(textResult.text);
    } catch (error) {
      // 加密 PDF 无法解析，必须把原因带出去，不能当成「没文字」。
      if (/password|encrypt/i.test(errorMessage(error))) throw error;
      text = "";
    }

    let tables: string[][][] = [];
    try {
      const tableResult = await parser.getTable();
      pageCount = pageCount || tableResult.pages?.length || 0;
      tables = (tableResult.pages ?? [])
        .flatMap((page) => page.tables ?? [])
        .filter((rows) => rows.length >= 2 && rows.some((cells) => cells.length >= 2))
        .map((rows) => rows.map((cells) => cells.map((cell) => String(cell ?? "").trim())));
    } catch {
      tables = [];
    }

    const hasTextLayer = text.length > 0;
    // 文字层能读但排版是乱的（农商行流水）：表格才是可信来源，优先用它。
    const statementTableText = buildStatementTableText(tables, text);
    if (statementTableText) {
      return {
        text: statementTableText, tables, pageCount, hasTextLayer, error: null,
        passwordRequired: false, passwordIncorrect: false,
        encryptionUnsupported: false,
      };
    }
    // 有些账单文字层只散落着页眉，真正的明细全在表格里。
    if (!hasTextLayer || text.length < 40) {
      const tableText = tablesToText(tables, text);
      if (tableText.length > text.length) {
        return {
          text: tableText, tables, pageCount, hasTextLayer, error: null,
          passwordRequired: false, passwordIncorrect: false,
          encryptionUnsupported: false,
        };
      }
    }
    return {
      text, tables, pageCount, hasTextLayer, error: null,
      passwordRequired: false, passwordIncorrect: false,
      encryptionUnsupported: false,
    };
  } catch (error) {
    const message = errorMessage(error) || "unknown error";
    return {
      ...EMPTY_RESULT,
      error: message,
      ...classifyPdfParseError(message),
    };
  } finally {
    if (parser) await parser.destroy().catch(() => undefined);
  }
}

export async function extractPdfText(content: Buffer) {
  const result = await extractPdfContent(content);
  return result.text;
}
