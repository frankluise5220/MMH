import { NextRequest, NextResponse } from "next/server";
import { connectAndOpenBox, closeImap } from "@/lib/mail/imap-client";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { isAdmin } from "@/lib/server/auth";

export const runtime = "nodejs";

/**
 * POST /api/v1/settings/email-accounts/test
 * Tests the IMAP connection and SMTP sending for an email account.
 * Body: { accountId?, imapHost, imapPort, imapSecure, username, password?, mailbox?, smtpHost?, smtpPort?, smtpFrom? }
 * When modifying a saved account, pass accountId and omit password; the server
 * uses the saved authorization code of that household account for testing.
 */
export async function POST(req: NextRequest) {
  const { householdId, user } = await getHouseholdScope();
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ ok: false, code: "ADMIN_REQUIRED", error: "仅管理员可操作" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const accountId = String(body.accountId ?? "").trim();
  const imapHost = String(body.imapHost ?? "").trim();
  const imapPort = Number(body.imapPort) || 993;
  const imapSecure = body.imapSecure !== false;
  const username = String(body.username ?? "").trim();
  let password = String(body.password ?? "").trim();
  const mailbox = String(body.mailbox ?? "INBOX").trim() || "INBOX";

  if (!password && accountId) {
    const existing = await prisma.emailAccount.findFirst({
      where: { id: accountId, householdId },
      select: { password: true },
    });
    password = existing?.password ?? "";
  }

  if (!imapHost || !username || !password) {
    return NextResponse.json({ ok: false, code: "INCOMPLETE_CONFIG", error: "请填写完整配置；新账户必须填写授权码，修改账户如需重新测试也要保留或填写授权码" }, { status: 400 });
  }

  const results: string[] = [];

  // Test IMAP
  try {
    const client = connectAndOpenBox({ host: imapHost, port: imapPort, secure: imapSecure, user: username, password, mailbox }, []);
    const imapResult = await Promise.race([
      client,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("IMAP 连接超时")), 15000)),
    ]);
    results.push(`IMAP 连接成功 (${imapResult.mailbox})`);
    closeImap(imapResult.client);
  } catch (e) {
    results.push(`IMAP 失败: ${e instanceof Error ? e.message : "未知错误"}`);
    return NextResponse.json({ ok: false, code: "IMAP_CONNECT_FAILED", error: results.join("; ") });
  }

  // Test SMTP (optional)
  const smtpHost = String(body.smtpHost ?? "").trim();
  const smtpPort = Number(body.smtpPort) || 465;
  const smtpSecure = body.smtpSecure === undefined ? smtpPort === 465 : body.smtpSecure !== false;
  const smtpFrom = String(body.smtpFrom ?? "").trim();
  if (smtpHost && smtpFrom) {
    try {
      const nodemailer = await import("nodemailer");
      const transporter = nodemailer.createTransport({
        host: smtpHost, port: smtpPort, secure: smtpSecure,
        auth: { user: username, pass: password },
      });
      await transporter.verify();
      results.push("SMTP 连接成功");
    } catch (e) {
      results.push(`SMTP 失败: ${e instanceof Error ? e.message : "未知错误"}`);
      return NextResponse.json({ ok: false, code: "SMTP_CONNECT_FAILED", error: results.join("; ") });
    }
  }

  return NextResponse.json({ ok: true, results });
}
