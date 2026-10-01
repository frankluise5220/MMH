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
  const hasRelay = isMailRelayConfigured();
  if (!hasResend && !hasSmtp && !hasRelay) {
    return {
      ok: false,
      error: "No email service is configured (SMTP or Resend or mail relay), so the verification code could not be sent.",
    };
  }

  // The relay is the preferred path for MMH verification codes (it only carries
  // recipient + code + expiry, never a password, and avoids the unreliable
  // api.resend.com egress). It is used whenever configured; SMTP is still
  // honored only when the caller explicitly allows it.
  if (hasRelay) {
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

  const content = buildRegistrationContent(params);

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
  const content = buildRegistrationContent(p);
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
