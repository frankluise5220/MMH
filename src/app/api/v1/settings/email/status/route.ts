import { NextResponse } from "next/server";
import { hasAnySmtpConfig } from "@/lib/mail/smtp";
import { hasAnyResendConfig } from "@/lib/mail/resend";

export const runtime = "nodejs";

/**
 * GET /api/v1/settings/email/status
 * 返回邮件服务可用状态（用于密码找回自动检测）
 */
export async function GET() {
  // 检查 Resend（SystemSetting + env）
  const hasResend = await hasAnyResendConfig();

  // 检查 SMTP（统一走实际发送会使用的解析路径）
  const hasSmtp = await hasAnySmtpConfig();

  return NextResponse.json({
    ok: true,
    hasEmailService: hasResend || hasSmtp,
    hasResend,
    hasSmtp,
  });
}
