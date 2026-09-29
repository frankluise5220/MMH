import { sendEmailByResend, hasAnyResendConfig } from "./resend";
import { sendEmail, hasAnySmtpConfig } from "./smtp";

type RegistrationEmailParams = {
  to: string;
  code: string;
  expiresMinutes: number;
  householdId?: string | null;
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
  const [hasResend, hasSmtp] = await Promise.all([
    hasAnyResendConfig(),
    hasAnySmtpConfig(params.householdId),
  ]);
  if (!hasResend && !hasSmtp) {
    return {
      ok: false,
      error: "No email service is configured (SMTP or Resend), so the verification code could not be sent.",
    };
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
    error: "No email service is configured (SMTP or Resend), so the verification code could not be sent.",
  };
}
