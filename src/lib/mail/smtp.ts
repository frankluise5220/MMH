import nodemailer from "nodemailer";
import { prisma } from "@/lib/db/prisma";

type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
};

function parseBool(v: string | undefined, defaultValue: boolean) {
  const raw = (v ?? "").trim().toLowerCase();
  if (!raw) return defaultValue;
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "y") return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "n") return false;
  return defaultValue;
}

export function getSmtpConfig(): SmtpConfig | null {
  const host = (process.env.SMTP_HOST ?? "").trim();
  const port = Number(process.env.SMTP_PORT ?? "");
  const secure = parseBool(process.env.SMTP_SECURE, port === 465);
  const user = (process.env.SMTP_USER ?? "").trim();
  const pass = (process.env.SMTP_PASS ?? "").trim();
  const from = (process.env.SMTP_FROM ?? user).trim();
  if (!host || !Number.isFinite(port) || port <= 0 || !user || !pass || !from) return null;
  return { host, port, secure, user, pass, from };
}

/** 从数据库读取 SMTP 配置（用户在设置页面填写的），优先于 env */
export async function getDbSmtpConfig(): Promise<SmtpConfig | null> {
  try {
    const users = await prisma.user.findMany({ where: { role: "admin" }, take: 1 });
    if (!users[0]) return null;
    const settings = await prisma.userSettings.findUnique({ where: { userId: users[0].id } });
    if (settings?.smtpHost && settings.smtpPort && settings.smtpUser && settings.smtpPass && settings.smtpFrom) {
      return {
        host: settings.smtpHost,
        port: settings.smtpPort,
        secure: settings.smtpSecure ?? true,
        user: settings.smtpUser,
        pass: settings.smtpPass,
        from: settings.smtpFrom,
      };
    }
  } catch {
    // db 不可用时 fallback
  }
  return null;
}

async function resolveSmtpConfig(): Promise<SmtpConfig | null> {
  const db = await getDbSmtpConfig();
  if (db) return db;
  return getSmtpConfig();
}

export function hasSmtpConfig(): boolean {
  return getSmtpConfig() !== null;
}

export async function sendEmail(params: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}) {
  const cfg = await resolveSmtpConfig();
  if (!cfg) {
    return { ok: false as const, error: "未配置 SMTP 邮件服务" };
  }

  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
  });

  await transporter.sendMail({
    from: cfg.from,
    to: params.to,
    subject: params.subject,
    text: params.text,
    html: params.html,
  });

  return { ok: true as const };
}

export async function sendPasswordResetEmail(params: {
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
  return sendEmail({ to: params.to, subject, text, html });
}