import { NextResponse } from "next/server";

import { extractPdfContent } from "@/lib/mail/pdf";
import { getHouseholdScope } from "@/lib/server/household-scope";

// pdf-parse 依赖 pdfjs 与原生 canvas，只能在 Node runtime 跑（不能上 edge）。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 信用卡账单 PDF 通常 < 2MB；给到 25MB 是为了容得下多期合并的长账单。 */
const MAX_PDF_BYTES = 25 * 1024 * 1024;

function fail(code: string, error: string, status = 400) {
  return NextResponse.json({ ok: false, code, error }, { status });
}

/**
 * PDF → 文本。
 *
 * 邮件附件那条通道在服务端 imap-client 里已经抽过文字；这里是给「用户直接上传 PDF」
 * 用的同一个抽取函数，前端拿到 text 后仍走 `/api/v1/statement/parse` 的同一条识别链路。
 * 拆成两步而不是在服务端再串一次识别，是为了不再复制一份 parse 的路由逻辑。
 */
export async function POST(req: Request) {
  try {
    await getHouseholdScope();

    const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
    let buffer: Buffer;
    let filename = "";
    /** 加密 PDF 的打开密码（农商行等电子流水默认加密，界面会让用户补这一项）。 */
    let password = "";

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData().catch(() => null);
      const file = form?.get("file");
      if (!(file instanceof File)) return fail("MISSING_FILE", "缺少 PDF 文件");
      if (file.size === 0) return fail("EMPTY_FILE", "PDF 文件是空的");
      if (file.size > MAX_PDF_BYTES) {
        return fail("FILE_TOO_LARGE", `PDF 超过 ${Math.round(MAX_PDF_BYTES / 1024 / 1024)}MB，请拆分后再导入`, 413);
      }
      const formPassword = form?.get("password");
      password = typeof formPassword === "string" ? formPassword.trim().slice(0, 200) : "";
      filename = file.name || "statement.pdf";
      buffer = Buffer.from(await file.arrayBuffer());
    } else {
      const raw = Buffer.from(await req.arrayBuffer());
      if (raw.length === 0) return fail("EMPTY_FILE", "PDF 文件是空的");
      if (raw.length > MAX_PDF_BYTES) {
        return fail("FILE_TOO_LARGE", `PDF 超过 ${Math.round(MAX_PDF_BYTES / 1024 / 1024)}MB，请拆分后再导入`, 413);
      }
      buffer = raw;
    }

    // 只认 PDF：别的格式在 Excel 通道里读，这里混进来只会得到一堆乱码文本。
    if (buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
      return fail("NOT_PDF", "这个文件不是 PDF（可能改过扩展名）");
    }

    const pdf = await extractPdfContent(buffer, { password });
    if (pdf.passwordRequired) {
      return fail(
        "PDF_ENCRYPTED",
        password ? "PDF 打开密码不正确，请重新输入" : "PDF 有打开密码，请输入密码后再导入",
      );
    }
    // 加密方式不认（pdfjs 读加密字典就拒绝）：补密码也没用，只能引导用户另存为未加密 PDF。
    // 这条必须排在通用失败之前，否则会被说成「文件可能已损坏」，用户以为少弹了密码框。
    if (pdf.encryptionUnsupported) {
      console.warn("[statement/parse-pdf] unsupported encryption", { filename, error: pdf.error });
      return fail(
        "PDF_ENCRYPTION_UNSUPPORTED",
        "这份 PDF 的加密方式暂不支持（与密码无关）。请用 PDF 阅读器输入密码打开后「另存为」或「打印为 PDF」去掉加密，再导入",
      );
    }
    if (pdf.error) {
      console.warn("[statement/parse-pdf] parse failed", { filename, error: pdf.error });
      return fail("PDF_PARSE_FAILED", `PDF 解析失败：${pdf.error}`);
    }
    if (!pdf.hasTextLayer && !pdf.text.trim()) {
      return fail(
        "PDF_NO_TEXT_LAYER",
        "这个 PDF 没有文字层（多半是扫描件/图片版账单），目前无法识别其中的明细",
      );
    }

    return NextResponse.json({
      ok: true,
      filename,
      text: pdf.text,
      pageCount: pdf.pageCount,
      hasTextLayer: pdf.hasTextLayer,
    });
  } catch (error) {
    // getHouseholdScope 未登录时抛错，交给统一错误体，前端按「识别失败」展示。
    const message = error instanceof Error ? error.message : String(error ?? "");
    return fail("PARSE_FAILED", message || "PDF 解析失败", 500);
  }
}
