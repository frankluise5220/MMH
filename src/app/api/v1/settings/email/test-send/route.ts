import { NextRequest, NextResponse } from "next/server";
import { sendEmailByResend, hasAnyResendConfig } from "@/lib/mail/resend";
import { sendEmail, hasAnySmtpConfig } from "@/lib/mail/smtp";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";

export const runtime = "nodejs";

/**
 * POST /api/v1/settings/email/test-send
 *
 * Sends a test email using the currently saved mail configuration (admin only).
 * Prefers SMTP, falls back to Resend.
 * Body: { to: string } - recipient email address
 */
export async function POST(req: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "请先登录" }, { status: 401 });
  }
  if (!isAdmin(currentUser)) {
    return NextResponse.json({ ok: false, code: "ADMIN_ONLY", error: "仅管理员可操作" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const to = String(body.to ?? "").trim();
  if (!to) {
    return NextResponse.json({ ok: false, code: "MISSING_RECIPIENT_EMAIL", error: "缺少收件邮箱" }, { status: 400 });
  }

  const sendErrors: string[] = [];

  if (await hasAnySmtpConfig()) {
    const result = await sendEmail({
      to,
      subject: "MMH 邮件测试",
      text: "如果你收到这封邮件，说明 SMTP 发件配置正确。",
      html: "<div><h2>MMH 邮件测试</h2><p>如果你收到这封邮件，说明 SMTP 发件配置正确。</p></div>",
    });
    if (result.ok) return NextResponse.json(result);
    sendErrors.push(result.error);
  }

  if (await hasAnyResendConfig()) {
    const result = await sendEmailByResend({
      to,
      subject: "MMH 邮件测试",
      text: "如果你收到这封邮件，说明 Resend 发件配置正确。",
      html: "<div><h2>MMH 邮件测试</h2><p>如果你收到这封邮件，说明 Resend 发件配置正确。</p></div>",
    });
    if (result.ok) return NextResponse.json(result);
    sendErrors.push(result.error);
  }

  return NextResponse.json({
    ok: false,
    error: sendErrors.join("; ") || "未配置可用的邮件发送服务。",
  });
}
