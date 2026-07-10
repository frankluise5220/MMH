import nodemailer from "nodemailer";
import { prisma } from "@/lib/db/prisma";

type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  sourceLabel?: string;
};

function normalizeSmtpError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  const responseCode = typeof error === "object" && error && "responseCode" in error ? Number((error as { responseCode?: unknown }).responseCode) : NaN;
  const lower = message.toLowerCase();

  if (code === "EAUTH" || responseCode === 535 || lower.includes("auth") || lower.includes("invalid login")) {
    return "SMTP 认证失败，请检查邮箱账号、授权码或 SMTP 用户名密码。";
  }
  if (code === "ESOCKET" || code === "ECONNECTION" || code === "ETIMEDOUT" || code === "ENOTFOUND") {
    return "SMTP 连接失败，请检查服务器地址、端口、TLS/SSL 设置和网络连接。";
  }
  if (responseCode === 553 || responseCode === 550 || lower.includes("sender address")) {
    return "SMTP 发件地址被拒绝，请检查发件地址是否与邮箱服务配置一致。";
  }
  return message || "SMTP 发信失败";
}

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
  return { host, port, secure, user, pass, from, sourceLabel: "环境变量 SMTP" };
}

function smtpConfigKey(config: Pick<SmtpConfig, "host" | "port" | "secure" | "user" | "from">) {
  return `${config.host}::${config.port}::${config.secure ? "1" : "0"}::${config.user}::${config.from}`;
}

function pushUniqueConfig(list: SmtpConfig[], config: SmtpConfig | null, seen: Set<string>) {
  if (!config) return;
  const key = smtpConfigKey(config);
  if (seen.has(key)) return;
  seen.add(key);
  list.push(config);
}

async function listEmailAccountSmtpConfigs(householdId?: string | null): Promise<SmtpConfig[]> {
  try {
    const localAccounts = householdId
      ? await prisma.emailAccount.findMany({
          where: { householdId, outboundType: "smtp", smtpHost: { not: null }, smtpFrom: { not: null } },
          orderBy: { createdAt: "asc" },
          select: {
            label: true,
            username: true,
            smtpHost: true,
            smtpPort: true,
            smtpSecure: true,
            smtpFrom: true,
            password: true,
          },
        })
      : [];
    const fallbackAccounts = await prisma.emailAccount.findMany({
      where: householdId
        ? { householdId: { not: householdId }, outboundType: "smtp", smtpHost: { not: null }, smtpFrom: { not: null } }
        : { outboundType: "smtp", smtpHost: { not: null }, smtpFrom: { not: null } },
      orderBy: { createdAt: "asc" },
      select: {
        label: true,
        username: true,
        smtpHost: true,
        smtpPort: true,
        smtpSecure: true,
        smtpFrom: true,
        password: true,
      },
    });

    return [...localAccounts, ...fallbackAccounts]
      .filter((account) => account.smtpHost && account.smtpFrom && account.username && account.password)
      .map((account) => ({
        host: account.smtpHost!,
        port: account.smtpPort ?? 465,
        secure: account.smtpSecure ?? true,
        user: account.username,
        pass: account.password,
        from: account.smtpFrom!,
        sourceLabel: `邮箱账户 ${account.label}`,
      }));
  } catch {
    return [];
  }
}

async function getLegacyUserSettingsSmtpConfig(householdId?: string | null): Promise<SmtpConfig | null> {
  try {
    const adminUser = householdId
      ? await prisma.user.findFirst({
          where: { role: "admin", householdId },
          orderBy: { createdAt: "asc" },
          select: { id: true },
        }) ?? await prisma.user.findFirst({
          where: { role: "admin" },
          orderBy: { createdAt: "asc" },
          select: { id: true },
        })
      : await prisma.user.findFirst({
          where: { role: "admin" },
          orderBy: { createdAt: "asc" },
          select: { id: true },
        });
    if (!adminUser) return null;
    const settings = await prisma.userSettings.findUnique({ where: { userId: adminUser.id } });
    if (settings?.smtpHost && settings.smtpPort && settings.smtpUser && settings.smtpPass && settings.smtpFrom) {
      return {
        host: settings.smtpHost,
        port: settings.smtpPort,
        secure: settings.smtpSecure ?? true,
        user: settings.smtpUser,
        pass: settings.smtpPass,
        from: settings.smtpFrom,
        sourceLabel: "旧版用户 SMTP 设置",
      };
    }
  } catch {
    // db 不可用时 fallback
  }
  return null;
}

async function resolveSmtpConfigs(householdId?: string | null): Promise<SmtpConfig[]> {
  const candidates: SmtpConfig[] = [];
  const seen = new Set<string>();

  const accountConfigs = await listEmailAccountSmtpConfigs(householdId);
  for (const config of accountConfigs) {
    pushUniqueConfig(candidates, config, seen);
  }

  pushUniqueConfig(candidates, await getLegacyUserSettingsSmtpConfig(householdId), seen);
  pushUniqueConfig(candidates, getSmtpConfig(), seen);

  return candidates;
}

export function hasSmtpConfig(): boolean {
  return getSmtpConfig() !== null;
}

export async function hasAnySmtpConfig(householdId?: string | null): Promise<boolean> {
  return (await resolveSmtpConfigs(householdId)).length > 0;
}

export async function sendEmail(params: {
  to: string;
  subject: string;
  text: string;
  html?: string;
  householdId?: string | null;
}) {
  const configs = await resolveSmtpConfigs(params.householdId);
  if (configs.length === 0) {
    return { ok: false as const, error: "未配置 SMTP 邮件服务" };
  }

  const errors: string[] = [];
  for (const cfg of configs) {
    const transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
    });

    try {
      await transporter.sendMail({
        from: cfg.from,
        to: params.to,
        subject: params.subject,
        text: params.text,
        html: params.html,
      });

      return { ok: true as const };
    } catch (error) {
      const prefix = cfg.sourceLabel ? `${cfg.sourceLabel}：` : "";
      errors.push(`${prefix}${normalizeSmtpError(error)}`);
    }
  }

  return { ok: false as const, error: errors[0] ?? "SMTP 发信失败" };
}
