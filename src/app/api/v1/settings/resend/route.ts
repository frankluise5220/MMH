import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getEnvResendConfig } from "@/lib/mail/resend";

export const runtime = "nodejs";

/**
 * GET /api/v1/settings/resend
 * 获取 Resend 发件配置（API Key 和发件地址）
 */
export async function GET() {
  const setting = await prisma.systemSetting.findUnique({ where: { key: "resend_config" } });
  const envConfig = getEnvResendConfig();
  const fallback = {
    apiKey: envConfig?.apiKey ?? "",
    from: envConfig?.from ?? "",
    source: envConfig ? "env" : "none",
  };

  if (!setting) {
    return NextResponse.json({ ok: true, data: fallback });
  }

  try {
    const parsed = JSON.parse(setting.value) as { apiKey?: string; from?: string };
    const apiKey = String(parsed.apiKey ?? "").trim();
    const from = String(parsed.from ?? "").trim();
    if (!apiKey) return NextResponse.json({ ok: true, data: fallback });
    return NextResponse.json({ ok: true, data: { apiKey, from: from || fallback.from, source: "db" } });
  } catch {
    return NextResponse.json({ ok: true, data: fallback });
  }
}

/**
 * POST /api/v1/settings/resend
 * 保存 Resend 发件配置
 * Body: { apiKey: string, from: string }
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const apiKey = String(body.apiKey ?? "").trim();
  const from = String(body.from ?? "").trim();

  const value = JSON.stringify({ apiKey, from });
  await prisma.systemSetting.upsert({
    where: { key: "resend_config" },
    update: { value },
    create: { key: "resend_config", value },
  });

  return NextResponse.json({ ok: true });
}
