import { prisma } from "@/lib/db/prisma";

type ResendConfig = {
  apiKey: string;
  from: string;
};

function getResendConfig(): ResendConfig | null {
  const apiKey = (process.env.RESEND_API_KEY ?? "").trim();
  const from = (process.env.RESEND_FROM ?? process.env.MAIL_FROM ?? "").trim();
  if (!apiKey || !from) return null;
  return { apiKey, from };
}

/** 从数据库读取 Resend 配置（用户在设置页面填写的），优先于 env */
async function getDbResendConfig(): Promise<ResendConfig | null> {
  try {
    const users = await prisma.user.findMany({ where: { role: "admin" }, take: 1 });
    if (!users[0]) return null;
    const settings = await prisma.userSettings.findUnique({ where: { userId: users[0].id } });
    if (settings?.resendApiKey && settings?.resendFrom) {
      return { apiKey: settings.resendApiKey, from: settings.resendFrom };
    }
  } catch {}
  return null;
}

async function resolveResendConfig(): Promise<ResendConfig | null> {
  const db = await getDbResendConfig();
  if (db) return db;
  return getResendConfig();
}

export function hasResendConfig(): boolean {
  return getResendConfig() !== null;
}

export async function sendEmailByResend(params: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}) {
  const cfg = await resolveResendConfig();
  if (!cfg) {
    return { ok: false as const, error: "未配置 Resend 邮件服务" };
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      from: cfg.from,
      to: params.to,
      subject: params.subject,
      text: params.text,
      html: params.html,
    }),
  });

  const data = await res.json().catch(() => null) as { message?: string; name?: string; error?: string } | null;
  if (!res.ok) {
    return { ok: false as const, error: data?.message || data?.error || `Resend 发信失败：${res.status}` };
  }

  return { ok: true as const };
}

export async function sendPasswordResetEmailByResend(params: {
  to: string;
  username: string;
  code: string;
  expiresMinutes: number;
}) {
  const subject = "WiseMe 密码找回验证码";
  const text = `你正在找回 WiseMe 账号（${params.username}）的密码。\n\n验证码：${params.code}\n有效期：${params.expiresMinutes} 分钟\n\n如果不是你本人操作，请忽略本邮件。`;
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.7; color: #0f172a;">
      <h2 style="margin: 0 0 12px;">WiseMe 密码找回验证码</h2>
      <p>你正在找回 WiseMe 账号（${params.username}）的密码。</p>
      <p style="font-size: 24px; letter-spacing: 6px; font-weight: 700; margin: 18px 0;">${params.code}</p>
      <p>验证码有效期：${params.expiresMinutes} 分钟。</p>
      <p style="color: #64748b; font-size: 13px;">如果不是你本人操作，请忽略本邮件。</p>
    </div>
  `;
  return sendEmailByResend({ to: params.to, subject, text, html });
}