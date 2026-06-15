import { NextRequest, NextResponse } from "next/server";
import { sendEmailByResend } from "@/lib/mail/resend";
import { sendEmail } from "@/lib/mail/smtp";
import { prisma } from "@/lib/db/prisma";

export const runtime = "nodejs";

/**
 * POST /api/v1/settings/email/test-send
 *
 * 使用当前保存的发件配置发送测试邮件。
 * 优先 SMTP，其次 Resend。
 * Body: { to: string } - 收件邮箱地址
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const to = String(body.to ?? "").trim();
  if (!to) {
    return NextResponse.json({ ok: false, error: "缺少收件邮箱" }, { status: 400 });
  }

  // 检查 SMTP 数据库配置
  let hasSmtpDb = false;
  try {
    const users = await prisma.user.findMany({ where: { role: "admin" }, take: 1 });
    if (users[0]) {
      const settings = await prisma.userSettings.findUnique({ where: { userId: users[0].id } });
      hasSmtpDb = Boolean(settings?.smtpHost && settings?.smtpUser && settings?.smtpPass);
    }
  } catch {}

  if (hasSmtpDb) {
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