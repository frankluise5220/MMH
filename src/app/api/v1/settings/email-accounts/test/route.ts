import { NextRequest, NextResponse } from "next/server";
import { connectAndOpenBox, closeImap } from "@/lib/mail/imap-client";

export const runtime = "nodejs";

/**
 * POST /api/v1/settings/email-accounts/test
 * 测试邮箱账户的 IMAP 连接和 SMTP 发件功能
 * Body: { imapHost, imapPort, imapSecure, username, password, mailbox?, smtpHost?, smtpPort?, smtpFrom? }
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const imapHost = String(body.imapHost ?? "").trim();
  const imapPort = Number(body.imapPort) || 993;
  const imapSecure = body.imapSecure !== false;
  const username = String(body.username ?? "").trim();
  const password = String(body.password ?? "").trim();
  const mailbox = String(body.mailbox ?? "INBOX").trim() || "INBOX";

  if (!imapHost || !username || !password) {
    return NextResponse.json({ ok: false, error: "请填写完整配置" }, { status: 400 });
  }

  const results: string[] = [];

  // 测试 IMAP
  try {
    const client = connectAndOpenBox({ host: imapHost, port: imapPort, secure: imapSecure, user: username, password, mailbox }, []);
    const imapResult = await Promise.race([
      client,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("IMAP 连接超时")), 15000)),
    ]);
    results.push(`IMAP 连接成功 (${imapResult.mailbox})`);
    closeImap(imapResult.imap);
  } catch (e) {
    results.push(`IMAP 失败: ${e instanceof Error ? e.message : "未知错误"}`);
    return NextResponse.json({ ok: false, error: results.join("; ") });
  }

  // 测试 SMTP（可选）
  const smtpHost = String(body.smtpHost ?? "").trim();
  const smtpPort = Number(body.smtpPort) || 465;
  const smtpFrom = String(body.smtpFrom ?? "").trim();
  if (smtpHost && smtpFrom) {
    try {
      const nodemailer = await import("nodemailer");
      const transporter = nodemailer.createTransport({
        host: smtpHost, port: smtpPort, secure: true,
        auth: { user: username, pass: password },
      });
      await transporter.verify();
      results.push("SMTP 连接成功");
    } catch (e) {
      results.push(`SMTP 失败: ${e instanceof Error ? e.message : "未知错误"}`);
    }
  }

  return NextResponse.json({ ok: true, results });
}