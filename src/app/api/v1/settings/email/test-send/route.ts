import { NextRequest, NextResponse } from "next/server";
import { sendEmailByResend } from "@/lib/mail/resend";
import { sendEmail, hasAnySmtpConfig } from "@/lib/mail/smtp";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";

export const runtime = "nodejs";

/**
 * POST /api/v1/settings/email/test-send
 *
 * 使用当前保存的发件配置发送测试邮件（仅管理员）。
 * 优先 SMTP，其次 Resend。
 * Body: { to: string } - 收件邮箱地址
 */
export async function POST(req: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ ok: false, error: "请先登录" }, { status: 401 });
  }
  if (!isAdmin(currentUser)) {
    return NextResponse.json({ ok: false, error: "仅管理员可操作" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const to = String(body.to ?? "").trim();
  if (!to) {
    return NextResponse.json({ ok: false, error: "缺少收件邮箱" }, { status: 400 });
  }

  if (await hasAnySmtpConfig()) {
    const result = await sendEmail({
      to,
      subject: "MMH 邮件测试",
      text: "如果你收到这封邮件，说明 SMTP 发件配置正确。",
      html: "<div><h2>MMH 邮件测试</h2><p>如果你收到这封邮件，说明 SMTP 发件配置正确。</p></div>",
    });
    return NextResponse.json(result);
  }

  // 尝试 Resend
  const result = await sendEmailByResend({
    to,
    subject: "MMH 邮件测试",
    text: "如果你收到这封邮件，说明 Resend 发件配置正确。",
    html: "<div><h2>MMH 邮件测试</h2><p>如果你收到这封邮件，说明 Resend 发件配置正确。</p></div>",
  });
  return NextResponse.json(result);
}
