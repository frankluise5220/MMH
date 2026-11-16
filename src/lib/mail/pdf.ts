import type { PDFParse as PDFParseInstance } from "pdf-parse";

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
};

const PAGE_JOINER = "\n";

const EMPTY_RESULT: PdfExtractResult = {
  text: "",
  tables: [],
  pageCount: 0,
  hasTextLayer: false,
  error: null,
};

/** 表格按单元格拼成文本，供没有排版信息的识别链路兜底。 */
function tablesToText(tables: string[][][]) {
  return tables
    .map((rows) => rows.map((cells) => cells.join("\t")).join("\n"))
    .filter((block) => block.trim().length > 0)
    .join("\n\n");
}

function normalizeText(value: unknown) {
  return String(value ?? "").replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "");
}

export async function extractPdfContent(content: Buffer): Promise<PdfExtractResult> {
  if (!content.length) return { ...EMPTY_RESULT };

  let parser: PDFParseInstance | null = null;
  try {
    const { PDFParse } = await import("pdf-parse");
    // 传副本，避免 worker 的 transfer 把调用方的 Buffer 挪走。
    parser = new PDFParse({ data: new Uint8Array(content) });

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
    // 有些账单文字层只散落着页眉，真正的明细全在表格里。
    if (!hasTextLayer || text.length < 40) {
      const tableText = tablesToText(tables);
      if (tableText.length > text.length) {
        return { text: tableText, tables, pageCount, hasTextLayer, error: null };
      }
    }
    return { text, tables, pageCount, hasTextLayer, error: null };
  } catch (error) {
    return { ...EMPTY_RESULT, error: errorMessage(error) || "unknown error" };
  } finally {
    if (parser) await parser.destroy().catch(() => undefined);
  }
}

export async function extractPdfText(content: Buffer) {
  const result = await extractPdfContent(content);
  return result.text;
}
