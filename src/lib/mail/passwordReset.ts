import { sendEmailByResend, hasAnyResendConfig } from "./resend";
import { sendEmail, hasAnySmtpConfig } from "./smtp";

type PasswordResetEmailParams = {
  to: string;
  username: string;
  code: string;
  expiresMinutes: number;
  householdId?: string | null;
  /** Ledger the local account lives in, so the mail can name it. */
  householdName?: string | null;
};

export type SendEmailResult = {
  ok: boolean;
  error?: string;
};

/**
 * Ledger-local password recovery. The wording has to be explicit about which
 * password this is: MMH has two independent ones (the ledger-local password and
 * the MMH membership password), and people routinely ask for the wrong one.
 */
function buildPasswordResetContent(params: PasswordResetEmailParams) {
  const ledger = (params.householdName ?? "").trim();
  const ledgerLine = ledger ? `账簿：${ledger}\n` : "";
  const ledgerHtml = ledger ? `<p>账簿：${ledger}</p>` : "";

  const subject = "MMH 本地账户密码找回验证码";
  const text =
    "你正在找回账簿「本地账户」的登录密码。\n\n" +
    ledgerLine +
    `账户：${params.username}\n` +
    `验证码：${params.code}\n` +
    `有效期：${params.expiresMinutes} 分钟\n\n` +
    "说明：这是账簿内的本地账户密码，不是 MMH 会员密码。\n" +
    "如果不是你本人操作，请忽略本邮件。";
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.7; color: #0f172a;">
      <h2 style="margin: 0 0 12px;">MMH 本地账户密码找回验证码</h2>
      <p>你正在找回账簿<strong>本地账户</strong>的登录密码。</p>
      ${ledgerHtml}
      <p>账户：${params.username}</p>
      <p style="font-size: 24px; letter-spacing: 6px; font-weight: 700; margin: 18px 0;">${params.code}</p>
      <p>验证码有效期：${params.expiresMinutes} 分钟。</p>
      <p style="color: #64748b; font-size: 13px;">这是账簿内的本地账户密码，不是 MMH 会员密码。如果不是你本人操作，请忽略本邮件。</p>
    </div>
  `;
  return { subject, text, html };
}

/** Checks whether any email sending service is available (auto-enable condition for password recovery) */
export async function hasEmailService(householdId?: string | null): Promise<boolean> {
  const [hasResend, hasSmtp] = await Promise.all([
    hasAnyResendConfig(),
    hasAnySmtpConfig(householdId),
  ]);
  return hasResend || hasSmtp;
}

export async function sendPasswordResetEmail(params: PasswordResetEmailParams): Promise<SendEmailResult> {
  const [hasResend, hasSmtp] = await Promise.all([
    hasAnyResendConfig(),
    hasAnySmtpConfig(params.householdId),
  ]);
  if (!hasResend && !hasSmtp) {
    return { ok: false, error: "未配置邮件服务，无法发送密码找回邮件。请在设置中配置 SMTP 或 Resend。" };
  }

  const content = buildPasswordResetContent(params);

  // Prefer the user's SMTP account, then fall back to Resend.
  if (hasSmtp) {
    const smtpResult = await sendEmail({ to: params.to, householdId: params.householdId, ...content });
    if (smtpResult.ok) return smtpResult;
    if (hasResend) {
      const resendResult = await sendEmailByResend({ to: params.to, ...content });
      if (resendResult.ok) return resendResult;
      return { ok: false, error: `${smtpResult.error ?? "SMTP 发信失败"}；Resend 备用通道也发送失败：${resendResult.error ?? "未知错误"}` };
    }
    return smtpResult;
  }

  if (hasResend) {
    return sendEmailByResend({ to: params.to, ...content });
  }

  return { ok: false, error: "未配置邮件服务，无法发送密码找回邮件。请在设置中配置 Resend 或 SMTP。" };
}
