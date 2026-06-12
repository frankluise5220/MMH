import nodemailer from "nodemailer";

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

function getSmtpConfig(): SmtpConfig | null {
  const host = (process.env.SMTP_HOST ?? "").trim();
  const port = Number(process.env.SMTP_PORT ?? "");
  const secure = parseBool(process.env.SMTP_SECURE, port === 465);
  const user = (process.env.SMTP_USER ?? "").trim();
  const pass = (process.env.SMTP_PASS ?? "").trim();
  const from = (process.env.SMTP_FROM ?? user).trim();
  if (!host || !Number.isFinite(port) || port <= 0 || !user || !pass || !from) return null;
  return { host, port, secure, user, pass, from };
}

export async function sendPasswordResetEmail(params: {
  to: string;
  username: string;
  code: string;
  expiresMinutes: number;
}) {
  const cfg = getSmtpConfig();
  if (!cfg) {
    return { ok: false as const, error: "未配置 SMTP 邮件服务" };
  }

  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
  });

  const subject = "WiseMe 密码找回验证码";
  const text = `你正在找回 WiseMe 账号（${params.username}）的密码。\n\n验证码：${params.code}\n有效期：${params.expiresMinutes} 分钟\n\n如果不是你本人操作，请忽略本邮件。`;

  await transporter.sendMail({
    from: cfg.from,
    to: params.to,
    subject,
    text,
  });

  return { ok: true as const };
}

