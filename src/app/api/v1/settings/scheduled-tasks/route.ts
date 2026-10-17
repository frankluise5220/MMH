import { NextRequest, NextResponse } from "next/server";

import { getHouseholdScope } from "@/lib/server/household-scope";
import {
  getSystemSetting,
  setSystemSetting,
  SCHEDULED_TASK_BALANCE_GUARD_SETTING_NAME,
} from "@/lib/server/system-setting";

export const runtime = "nodejs";

function normalizeBoolean(value: unknown) {
  return value === true || value === "true" || value === "1";
}

/**
 * GET /api/v1/settings/scheduled-tasks
 * Scheduled-task execution settings of the current household.
 * Response: { ok: true, data: { balanceGuard: boolean } }
 */
export async function GET() {
  const { householdId } = await getHouseholdScope();
  const stored = await getSystemSetting(SCHEDULED_TASK_BALANCE_GUARD_SETTING_NAME, { householdId });
  return NextResponse.json({ ok: true, data: { balanceGuard: normalizeBoolean(stored) } });
}

/**
 * PUT /api/v1/settings/scheduled-tasks
 * Body: { balanceGuard: boolean }
 *
 * This is a household behaviour preference ("how do this ledger's scheduled tasks
 * run?"), not a server-level maintenance setting, so any household member may
 * change it — same level as `/api/v1/settings/app-preferences`, no admin required.
 */
export async function PUT(req: NextRequest) {
  const { householdId, user } = await getHouseholdScope();
  if (!user) {
    return NextResponse.json(
      { ok: false, code: "LOGIN_REQUIRED", error: "Signing in is required to change scheduled-task settings." },
      { status: 401 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as { balanceGuard?: unknown };
  const balanceGuard = normalizeBoolean(body.balanceGuard);
  await setSystemSetting(
    SCHEDULED_TASK_BALANCE_GUARD_SETTING_NAME,
    balanceGuard ? "true" : "false",
    { householdId },
  );
  return NextResponse.json({ ok: true, data: { balanceGuard } });
}
