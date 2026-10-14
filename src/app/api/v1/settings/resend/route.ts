import { NextRequest, NextResponse } from "next/server";
import { RESEND_CONFIG_SETTING_KEY, RESEND_FROM, getEnvResendConfig } from "@/lib/mail/resend";
import { isAdmin } from "@/lib/server/auth";
import { getHouseholdScope } from "@/lib/server/household-scope";
import {
  deleteSystemSetting,
  getSystemSetting,
  parseJsonSetting,
  writeJsonSystemSetting,
} from "@/lib/server/system-setting";

export const runtime = "nodejs";

function maskApiKey(apiKey: string) {
  if (!apiKey) return "";
  if (apiKey.length <= 10) return "已保存";
  return `${apiKey.slice(0, 6)}****${apiKey.slice(-4)}`;
}

/**
 * GET /api/v1/settings/resend
 * Gets the Resend mail configuration (API key and sender address).
 */
export async function GET() {
  const stored = await getSystemSetting(RESEND_CONFIG_SETTING_KEY);
  const envConfig = getEnvResendConfig();
  const fallback = {
    configured: Boolean(envConfig?.apiKey),
    keyPreview: envConfig?.apiKey ? maskApiKey(envConfig.apiKey) : "",
    from: envConfig?.from ?? RESEND_FROM,
    source: envConfig ? "env" : "none",
    canDelete: false,
  };

  const parsed = parseJsonSetting<{ apiKey?: string; from?: string }>(stored);
  if (!parsed) return NextResponse.json({ ok: true, data: fallback });

  const apiKey = String(parsed.apiKey ?? "").trim();
  const from = String(parsed.from ?? "").trim();
  if (!apiKey) return NextResponse.json({ ok: true, data: fallback });
  return NextResponse.json({
    ok: true,
    data: {
      configured: true,
      keyPreview: maskApiKey(apiKey),
      from: from || fallback.from,
      source: "db",
      canDelete: true,
    },
  });
}

/**
 * POST /api/v1/settings/resend
 * Saves the Resend mail configuration.
 * Body: { apiKey: string, from: string }
 */
export async function POST(req: NextRequest) {
  const { user } = await getHouseholdScope();
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ ok: false, code: "ADMIN_ONLY", error: "仅管理员可操作" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const apiKey = String(body.apiKey ?? "").trim();
  const from = String(body.from ?? "").trim() || RESEND_FROM;

  if (!apiKey) {
    return NextResponse.json({ ok: false, code: "MISSING_RESEND_API_KEY", error: "请填写 Resend API Key" }, { status: 400 });
  }

  await writeJsonSystemSetting(RESEND_CONFIG_SETTING_KEY, { apiKey, from });

  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/v1/settings/resend
 * Deletes the Resend mail configuration saved in the database; env-based configuration cannot be deleted from the page.
 */
export async function DELETE() {
  const { user } = await getHouseholdScope();
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ ok: false, code: "ADMIN_ONLY", error: "仅管理员可操作" }, { status: 403 });
  }

  await deleteSystemSetting(RESEND_CONFIG_SETTING_KEY);
  return NextResponse.json({ ok: true });
}
