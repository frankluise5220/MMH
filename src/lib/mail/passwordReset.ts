import { sendPasswordResetEmailByResend, hasResendConfig } from "./resend";
import { sendPasswordResetEmail as sendPasswordResetEmailBySmtp } from "./smtp";

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

export async function sendPasswordResetEmail(params: PasswordResetEmailParams): Promise<SendEmailResult> {
  // SMTP 优先（可发到任意邮箱），Resend 备选（免费版只能发到注册邮箱）
  if (hasSmtpConfig()) {
    return sendPasswordResetEmailBySmtp(params);
  }
  if (hasResendConfig()) {
    return sendPasswordResetEmailByResend(params);
  }
  return { ok: false, error: "未配置邮件服务" };
}

export function hasEmailConfig(): boolean {
  return hasSmtpConfig() || hasResendConfig();
}

function hasSmtpConfig(): boolean {
  const host = (process.env.SMTP_HOST ?? "").trim();
  const user = (process.env.SMTP_USER ?? "").trim();
  const pass = (process.env.SMTP_PASS ?? "").trim();
  return Boolean(host && user && pass);
}