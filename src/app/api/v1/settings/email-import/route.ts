import { NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_EMAIL_IMPORT_KEYWORD,
  EMAIL_IMPORT_KEYWORD_SETTING_NAME,
  normalizeEmailImportKeyword,
} from "@/lib/mail/email-import-settings";
import { isAdmin } from "@/lib/server/auth";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { getSystemSetting, setSystemSetting } from "@/lib/server/system-setting";

export const runtime = "nodejs";

/**
 * GET /api/v1/settings/email-import
 * Returns the current household email bill import settings.
 * Response: { ok: true, data: { keyword } }
 */
export async function GET() {
  const { householdId } = await getHouseholdScope();
  const stored = await getSystemSetting(EMAIL_IMPORT_KEYWORD_SETTING_NAME, { householdId });
  return NextResponse.json({
    ok: true,
    data: { keyword: stored == null ? DEFAULT_EMAIL_IMPORT_KEYWORD : normalizeEmailImportKeyword(stored) },
  });
}

/**
 * PUT /api/v1/settings/email-import
 * Updates the current household email bill import settings.
 * Body: { keyword }
 * Response: { ok: true, data: { keyword } }
 */
export async function PUT(req: NextRequest) {
  const { householdId, user } = await getHouseholdScope();
  if (!user || !isAdmin(user)) {
    return NextResponse.json(
      { ok: false, code: "ADMIN_REQUIRED", error: "Administrator permission is required." },
      { status: 403 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as { keyword?: unknown };
  const keyword = normalizeEmailImportKeyword(body.keyword);
  await setSystemSetting(EMAIL_IMPORT_KEYWORD_SETTING_NAME, keyword, { householdId });
  return NextResponse.json({ ok: true, data: { keyword } });
}
