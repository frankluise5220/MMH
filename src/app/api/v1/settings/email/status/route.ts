import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { hasSmtpConfig } from "@/lib/mail/smtp";
import { hasResendConfig } from "@/lib/mail/resend";

export const runtime = "nodejs";

/**
 * GET /api/v1/settings/email/status
 * 返回邮件服务可用状态（用于密码找回自动检测）
 */
export async function GET() {
  // 检查 Resend（SystemSetting + env）
  const hasResend = await hasResendConfigAsync();

  // 检查 SMTP（EmailAccount + UserSettings + env）
  const hasSmtp = hasSmtpConfig() || await hasSmtpDbConfig();

  return NextResponse.json({
    ok: true,
    hasEmailService: hasResend || hasSmtp,
    hasResend,
    hasSmtp,
  });
}

async function hasResendConfigAsync(): Promise<boolean> {
  // env 配置
  if (hasResendConfig()) return true;
  // SystemSetting 配置
  try {
    const setting = await prisma.systemSetting.findUnique({ where: { key: "resend_config" } });
    if (setting) {
      const parsed = JSON.parse(setting.value) as { apiKey?: string; from?: string };
      if (parsed.apiKey && parsed.from) return true;
    }
  } catch {}
  return false;
}

async function hasSmtpDbConfig(): Promise<boolean> {
  try {
    const account = await prisma.emailAccount.findFirst({
      where: { smtpHost: { not: null }, smtpFrom: { not: null } },
    });
    if (account?.smtpHost && account?.smtpFrom) return true;
  } catch {}
  return false;
}
