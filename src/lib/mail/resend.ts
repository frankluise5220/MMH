import { prisma } from "@/lib/db/prisma";

/** 固定发件地址 */
const RESEND_FROM = "wiseme@floatingice.win";

type ResendConfig = {
  apiKey: string;
  from: string;
};

function getResendConfig(): ResendConfig | null {
  const apiKey = (process.env.RESEND_API_KEY ?? "").trim();
  if (!apiKey) return null;
  // env 可覆盖 from，但默认用固定值
  const from = (process.env.RESEND_FROM ?? "").trim() || RESEND_FROM;
  return { apiKey, from };
}

/** 从 SystemSetting 表或 env 读取 Resend 配置 */
async function getDbResendConfig(): Promise<ResendConfig | null> {
  try {
    const setting = await prisma.systemSetting.findUnique({ where: { key: "resend_config" } });
    if (setting) {
      const parsed = JSON.parse(setting.value) as { apiKey?: string; from?: string };
      if (parsed.apiKey) {
        // from 优先用数据库存的，但数据库存的就是固定值
        return { apiKey: parsed.apiKey, from: parsed.from || RESEND_FROM };
      }
    }
    // fallback: 旧 UserSettings（兼容旧数据）
    const users = await prisma.user.findMany({ where: { role: "admin" }, take: 1 });
    if (users[0]) {
      const settings = await prisma.userSettings.findUnique({ where: { userId: users[0].id } });
      if (settings?.resendApiKey) {
        return { apiKey: settings.resendApiKey, from: settings.resendFrom || RESEND_FROM };
      }
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
