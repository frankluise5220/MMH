import { sendEmailByResend, hasAnyResendConfig } from "./resend";
import { sendEmail, hasAnySmtpConfig } from "./smtp";
import { isMailRelayConfigured, sendVerificationCodeByRelay } from "./relay";

type RegistrationEmailParams = {
  to: string;
  code: string;
  expiresMinutes: number;
  householdId?: string | null;
  /** Public MMH signup must never borrow an SMTP account from another ledger. */
  allowSmtp?: boolean;
  /**
   * Which code this is. MMH issues two different codes over the same channel —
   * account registration and membership password recovery — and they need
   * different copy. Defaults to "registration".
   */
  purpose?: "registration" | "password-reset";
};

export type SendEmailResult = {
  ok: boolean;
  error?: string;
};

function buildRegistrationContent(params: RegistrationEmailParams) {
  const subject = "MMH account registration verification code";
  const text = `You are registering an MMH account (email: ${params.to}).\n\nVerification code: ${params.code}\nValid for ${params.expiresMinutes} minutes.\n\nIf you did not request this, please ignore this email.`;
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.7; color: #0f172a;">
      <h2 style="margin: 0 0 12px;">MMH account registration</h2>
      <p>You are registering an MMH account (email: ${params.to}).</p>
      <p style="font-size: 24px; letter-spacing: 6px; font-weight: 700; margin: 18px 0;">${params.code}</p>
      <p>This code is valid for ${params.expiresMinutes} minutes.</p>
      <p style="color: #64748b; font-size: 13px;">If you did not request this, please ignore this email.</p>
    </div>
  `;
  return { subject, text, html };
}

/**
 * MMH membership password recovery.
 *
 * Deliberately separate copy from registration: reusing the registration body
 * here told people "You are registering an MMH account" while they were trying
 * to *recover* a password. It also has to say which of the two MMH passwords
 * this is, since the ledger-local one has its own recovery mail.
 */
function buildMmhPasswordResetContent(params: RegistrationEmailParams) {
  const subject = "MMH 会员密码找回验证码";
  const text =
    `你正在找回 MMH 会员密码（账号：${params.to}）。\n\n` +
    `验证码：${params.code}\n` +
    `有效期：${params.expiresMinutes} 分钟\n\n` +
    "说明：这是 MMH 会员密码（跨账簿的中央身份密码），不是某个账簿内的本地账户密码。\n" +
    "如果不是你本人操作，请忽略本邮件。";
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.7; color: #0f172a;">
      <h2 style="margin: 0 0 12px;">MMH 会员密码找回验证码</h2>
      <p>你正在找回 MMH 会员密码（账号：${params.to}）。</p>
      <p style="font-size: 24px; letter-spacing: 6px; font-weight: 700; margin: 18px 0;">${params.code}</p>
      <p>验证码有效期：${params.expiresMinutes} 分钟。</p>
      <p style="color: #64748b; font-size: 13px;">这是 MMH 会员密码（跨账簿的中央身份密码），不是某个账簿内的本地账户密码。如果不是你本人操作，请忽略本邮件。</p>
    </div>
  `;
  return { subject, text, html };
}

function buildContent(params: RegistrationEmailParams) {
  return params.purpose === "password-reset"
    ? buildMmhPasswordResetContent(params)
    : buildRegistrationContent(params);
}

/** Checks whether any email sending service is available. */
export async function hasEmailService(householdId?: string | null): Promise<boolean> {
  const [hasResend, hasSmtp] = await Promise.all([
    hasAnyResendConfig(),
    hasAnySmtpConfig(householdId),
  ]);
  return hasResend || hasSmtp;
}

export async function sendRegistrationVerificationEmail(
  params: RegistrationEmailParams,
): Promise<SendEmailResult> {
  const allowSmtp = params.allowSmtp !== false;
  const [hasResend, hasSmtp] = await Promise.all([
    hasAnyResendConfig(),
    allowSmtp ? hasAnySmtpConfig(params.householdId) : Promise.resolve(false),
  ]);
  // The relay's body is generated server-side and hard-coded to the registration
  // wording (see panels/relay.py), so it may only carry registration codes. A
  // password-reset code has to go through Resend/SMTP, where the copy is chosen
  // here. The relay is otherwise still the preferred path (it only carries
  // recipient + code + expiry, never a password, and sidesteps the unreliable
  // api.resend.com egress).
  const relayUsable = isMailRelayConfigured() && params.purpose !== "password-reset";
  if (!hasResend && !hasSmtp && !relayUsable) {
    return {
      ok: false,
      error: "No email service is configured (SMTP or Resend or mail relay), so the verification code could not be sent.",
    };
  }

  if (relayUsable) {
    const relayResult = await sendVerificationCodeByRelay({
      to: params.to,
      code: params.code,
      expiresMinutes: params.expiresMinutes,
    });
    if (relayResult.ok) return relayResult;
    if (hasResend || hasSmtp) {
      // Fall through to the legacy path below; combine errors on final failure.
      return sendFallback({ params, hasResend, hasSmtp, relayError: relayResult.error });
    }
    return relayResult;
  }

  const content = buildContent(params);

  // Prefer the user's SMTP account, then fall back to Resend.
  if (hasSmtp) {
    const smtpResult = await sendEmail({
      to: params.to,
      householdId: params.householdId,
      ...content,
    });
    if (smtpResult.ok) return smtpResult;
    if (hasResend) {
      const resendResult = await sendEmailByResend({ to: params.to, ...content });
      if (resendResult.ok) return resendResult;
      return {
        ok: false,
        error: `${smtpResult.error ?? "SMTP sending failed"}; the Resend fallback also failed: ${resendResult.error ?? "unknown error"}`,
      };
    }
    return smtpResult;
  }

  if (hasResend) {
    return sendEmailByResend({ to: params.to, ...content });
  }

  return {
    ok: false,
    error: "No email service is configured (SMTP or Resend or mail relay), so the verification code could not be sent.",
  };
}

async function sendFallback(params: {
  params: RegistrationEmailParams;
  hasResend: boolean;
  hasSmtp: boolean;
  relayError?: string;
}): Promise<SendEmailResult> {
  const { params: p, hasResend, hasSmtp, relayError } = params;
  const content = buildContent(p);
  if (hasSmtp) {
    const smtpResult = await sendEmail({
      to: p.to,
      householdId: p.householdId,
      ...content,
    });
    if (smtpResult.ok) return smtpResult;
    if (hasResend) {
      const resendResult = await sendEmailByResend({ to: p.to, ...content });
      if (resendResult.ok) return resendResult;
      return {
        ok: false,
        error: `The mail relay failed (${relayError ?? "unknown error"}); SMTP also failed (${smtpResult.error ?? "unknown error"}); the Resend fallback also failed (${resendResult.error ?? "unknown error"}).`,
      };
    }
    return {
      ok: false,
      error: `The mail relay failed (${relayError ?? "unknown error"}); SMTP also failed (${smtpResult.error ?? "unknown error"}).`,
    };
  }
  if (hasResend) {
    const resendResult = await sendEmailByResend({ to: p.to, ...content });
    if (resendResult.ok) return resendResult;
    return {
      ok: false,
      error: `The mail relay failed (${relayError ?? "unknown error"}); the Resend fallback also failed (${resendResult.error ?? "unknown error"}).`,
    };
  }
  return {
    ok: false,
    error: relayError ?? "No email service is configured (SMTP or Resend or mail relay).",
  };
}
