import { NextRequest, NextResponse } from "next/server";
import { normalizeColorScheme } from "@/lib/preferences";
import { getHouseholdPreferences, updateHouseholdPreferences } from "@/lib/server/household-preferences";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { revalidateAfterSettingsChange } from "@/lib/server/revalidate";

// GET: 当前账簿的颜色方案（真源在 DB）。
export async function GET() {
  const { householdId } = await getHouseholdScope();
  const preferences = await getHouseholdPreferences(householdId);
  return NextResponse.json({ ok: true, colorScheme: preferences.colorScheme });
}

// PUT: 写库后把结果镜像回 cookie，客户端无需等下一次同步。
export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { colorScheme } = body as { colorScheme?: unknown };

  if (colorScheme !== "red_up_green_down" && colorScheme !== "green_up_red_down") {
    return NextResponse.json({ ok: false, code: "INVALID_COLOR_SCHEME", error: "无效的颜色方案" }, { status: 400 });
  }

  const { householdId } = await getHouseholdScope();
  const preferences = await updateHouseholdPreferences(householdId, { colorScheme: normalizeColorScheme(colorScheme) });
  revalidateAfterSettingsChange();

  const response = NextResponse.json({ ok: true, colorScheme: preferences.colorScheme });
  response.cookies.set("colorScheme", preferences.colorScheme, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: false,
    sameSite: "lax",
  });
  return response;
}
