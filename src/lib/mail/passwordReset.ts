import { sendEmailByResend, hasResendConfig } from "./resend";
import { sendEmail, hasSmtpConfig } from "./smtp";
import { prisma } from "@/lib/db/prisma";

type PasswordResetEmailParams = {
  to: string;
  username: string;
  code: string;
  expiresMinutes: number;
};

export type SendEmailResult = {
  ok: boolean;
  error?: string;
};

function buildPasswordResetContent(params: PasswordResetEmailParams) {
  const subject = "MMH 密码找回验证码";
  const text = `你正在找回 MMH 账号（${params.username}）的密码。\n\n验证码：${params.code}\n有效期：${params.expiresMinutes} 分钟\n\n如果不是你本人操作，请忽略本邮件。`;
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.7; color: #0f172a;">
      <h2 style="margin: 0 0 12px;">MMH 密码找回验证码</h2>
      <p>你正在找回 MMH 账号（${params.username}）的密码。</p>
      <p style="font-size: 24px; letter-spacing: 6px; font-weight: 700; margin: 18px 0;">${params.code}</p>
      <p>验证码有效期：${params.expiresMinutes} 分钟。</p>
      <p style="color: #64748b; font-size: 13px;">如果不是你本人操作，请忽略本邮件。</p>
    </div>
  `;
  return { subject, text, html };
}

/** 检查是否有可用的邮件发件服务（密码找回自动启用条件） */
export async function hasEmailService(): Promise<boolean> {
  // SMTP（env + EmailAccount + UserSettings）
  if (hasSmtpConfig()) return true;
  try {
    const account = await prisma.emailAccount.findFirst({
      where: { smtpHost: { not: null }, smtpFrom: { not: null } },
    });
    if (account?.smtpHost && account?.smtpFrom) return true;
  } catch {}

  // Resend（env + SystemSetting + UserSettings）
  if (hasResendConfig()) return true;
  try {
    const setting = await prisma.systemSetting.findUnique({ where: { key: "resend_config" } });
    if (setting) {
      const parsed = JSON.parse(setting.value) as { apiKey?: string };
      if (parsed.apiKey) return true;
    }
  } catch {}

  return false;
}

export async function sendPasswordResetEmail(params: PasswordResetEmailParams): Promise<SendEmailResult> {
  // 检查是否有邮件服务
  if (!await hasEmailService()) {
    return { ok: false, error: "未配置邮件服务，无法发送密码找回邮件。请在设置中配置 SMTP 或 Resend。" };
  }

  const content = buildPasswordResetContent(params);

  // SMTP 优先（可发到任意邮箱），Resend 备选
  if (hasSmtpConfig()) {
    return sendEmail({ to: params.to, ...content });
  }
  // 尝试数据库 SMTP
  try {
    const account = await prisma.emailAccount.findFirst({
      where: { smtpHost: { not: null }, smtpFrom: { not: null } },
    });
    if (account?.smtpHost && account?.smtpFrom) {
      return sendEmail({ to: params.to, ...content });
    }
  } catch {}

  // Resend
  return sendEmailByResend({ to: params.to, ...content });
}
