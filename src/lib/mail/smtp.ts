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

/** 从 EmailAccount 表读取 SMTP 配置，优先于旧 UserSettings 和 env */
export async function getDbSmtpConfig(): Promise<SmtpConfig | null> {
  try {
    const account = await prisma.emailAccount.findFirst({
      where: { outboundType: "smtp", smtpHost: { not: null }, smtpFrom: { not: null } },
      orderBy: { createdAt: "asc" },
    });
    if (account?.smtpHost && account?.smtpFrom) {
      return {
        host: account.smtpHost,
        port: account.smtpPort ?? 465,
        secure: account.smtpSecure ?? true,
        user: account.username,
        pass: account.password,
        from: account.smtpFrom,
      };
    }
    // fallback: 旧 UserSettings
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