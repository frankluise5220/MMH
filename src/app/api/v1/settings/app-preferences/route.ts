import { NextRequest, NextResponse } from "next/server";
import { normalizeCreditCardLabelTemplate } from "@/lib/account-display";
import { normalizeDateDisplayFormat } from "@/lib/date-utils";
import { prisma } from "@/lib/db/prisma";
import {
  PREFERENCE_COOKIE_MIRROR,
  normalizeAccountLabelFieldsSetting,
  normalizeBoolean,
  normalizeColorScheme,
  normalizeCreditCardLabelMode,
  normalizeDetailWindowYears,
  normalizeDisplayLanguage,
  normalizeFundUnitsDecimals,
  normalizeSessionDays,
  normalizeSidebarGroupMode,
  normalizeTimeZone,
  type AppPreferences,
} from "@/lib/preferences";
import { normalizeRowHeightMode } from "@/lib/row-height";
import { getHouseholdPreferences, updateHouseholdPreferences } from "@/lib/server/household-preferences";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { revalidateAfterSettingsChange } from "@/lib/server/revalidate";
import {
  HOUSEHOLD_COOKIE as HOUSEHOLD_KEY,
  USER_ID_COOKIE as USER_ID_KEY,
  USERNAME_COOKIE as USERNAME_KEY,
  VERIFIED_COOKIE as VERIFIED_KEY,
  createVerifiedSessionValue,
  sessionCookieOptions,
  verifyVerifiedSessionValue,
} from "@/lib/server/session-cookies";

/**
 * GET /api/v1/settings/app-preferences — 读取当前账簿的设置。
 * PUT /api/v1/settings/app-preferences — 接受任意子集并写库。
 *
 * 真源是 `HouseholdPreference`（见 prisma schema 注释）。cookie 只是把结果
 * 镜像给同步读取的客户端组件；`PreferencesSync` 在每次加载时用 GET 的结果
 * 校准镜像，所以换浏览器/换设备后设置会自动回来。
 */

type PreferencePatchBody = Partial<Record<keyof AppPreferences, unknown>>;

const COOKIE_OPTIONS = {
  path: "/",
  maxAge: 60 * 60 * 24 * 365,
  httpOnly: false,
  sameSite: "lax" as const,
};

function mirrorToCookies(response: NextResponse, preferences: AppPreferences) {
  for (const { key, pick } of PREFERENCE_COOKIE_MIRROR) {
    response.cookies.set(key, pick(preferences), COOKIE_OPTIONS);
  }

}

export async function GET() {
  try {
    const { householdId, user } = await getHouseholdScope();
    const preferences = await getHouseholdPreferences(householdId);
    // authenticated=false 让客户端不要用默认值覆盖本机镜像。
    return NextResponse.json({ ok: true, authenticated: Boolean(user), ...preferences });
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: "PREFERENCES_READ_FAILED", error: error instanceof Error ? error.message : "读取设置失败" },
      { status: 500 },
    );
  }
}

export async function PUT(req: NextRequest) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = (await req.json().catch(() => ({}))) as PreferencePatchBody;
    const has = (key: keyof AppPreferences) => Object.prototype.hasOwnProperty.call(body, key);

    const current = await getHouseholdPreferences(householdId);
    const patch: Partial<AppPreferences> = {};

    if (has("sessionDays")) patch.sessionDays = normalizeSessionDays(body.sessionDays);
    if (has("fundUnitsDecimals")) patch.fundUnitsDecimals = normalizeFundUnitsDecimals(body.fundUnitsDecimals);
    if (has("aiPanelEnabled")) patch.aiPanelEnabled = normalizeBoolean(body.aiPanelEnabled, current.aiPanelEnabled);
    if (has("timeZone")) patch.timeZone = normalizeTimeZone(body.timeZone);
    if (has("colorScheme")) patch.colorScheme = normalizeColorScheme(body.colorScheme);
    if (has("creditCardLabelMode")) patch.creditCardLabelMode = normalizeCreditCardLabelMode(body.creditCardLabelMode);
    if (has("creditCardLabelTemplate") || has("creditCardLabelMode")) {
      const mode = patch.creditCardLabelMode ?? current.creditCardLabelMode;
      const template = has("creditCardLabelTemplate") ? body.creditCardLabelTemplate : current.creditCardLabelTemplate;
      patch.creditCardLabelTemplate = normalizeCreditCardLabelTemplate(template, mode);
    }
    if (has("creditCardSidebarLabelTemplate")) {
      patch.creditCardSidebarLabelTemplate = normalizeCreditCardLabelTemplate(
        body.creditCardSidebarLabelTemplate,
        "short_last4",
      );
    }
    if (has("creditBillHideZero")) patch.creditBillHideZero = normalizeBoolean(body.creditBillHideZero, false);
    if (has("creditBillHideSettled")) patch.creditBillHideSettled = normalizeBoolean(body.creditBillHideSettled, false);
    if (has("creditBillShowRecentCycles")) {
      patch.creditBillShowRecentCycles = normalizeBoolean(body.creditBillShowRecentCycles, true);
    }
    if (has("displayLanguage")) patch.displayLanguage = normalizeDisplayLanguage(body.displayLanguage);
    if (has("dateDisplayFormat")) patch.dateDisplayFormat = normalizeDateDisplayFormat(body.dateDisplayFormat);
    if (has("sidebarGroupBy")) patch.sidebarGroupBy = normalizeSidebarGroupMode(body.sidebarGroupBy);
    if (has("sidebarHideZero")) patch.sidebarHideZero = normalizeBoolean(body.sidebarHideZero, false);
    if (has("sidebarHideInitialData")) {
      patch.sidebarHideInitialData = normalizeBoolean(body.sidebarHideInitialData, false);
    }
    if (has("sidebarShowFixedAssets")) {
      patch.sidebarShowFixedAssets = normalizeBoolean(body.sidebarShowFixedAssets, true);
    }
    if (has("sidebarShowAllCashEntries")) {
      patch.sidebarShowAllCashEntries = normalizeBoolean(body.sidebarShowAllCashEntries, true);
    }
    if (has("sidebarShowReimbursements")) {
      patch.sidebarShowReimbursements = normalizeBoolean(body.sidebarShowReimbursements, true);
    }
    if (has("detailDateBackground")) patch.detailDateBackground = normalizeBoolean(body.detailDateBackground, false);
    if (has("detailWindowYears")) patch.detailWindowYears = normalizeDetailWindowYears(body.detailWindowYears);
    if (has("rowHeightMode")) patch.rowHeightMode = normalizeRowHeightMode(body.rowHeightMode);
    if (has("accountLabelFields")) {
      patch.accountLabelFields = normalizeAccountLabelFieldsSetting(body.accountLabelFields);
    }
    if (has("accountDropdownRestrictType")) {
      patch.accountDropdownRestrictType = normalizeBoolean(body.accountDropdownRestrictType, true);
    }

    const preferences = await updateHouseholdPreferences(householdId, patch);
    revalidateAfterSettingsChange();

    const response = NextResponse.json({ ok: true, ...preferences });
    mirrorToCookies(response, preferences);

    // 会话 cookie 续期沿用原有逻辑：改设置同时延长登录态。
    const maxAge = preferences.sessionDays * 24 * 60 * 60;
    const verified = req.cookies.get(VERIFIED_KEY)?.value;
    const userId = req.cookies.get(USER_ID_KEY)?.value;
    const username = req.cookies.get(USERNAME_KEY)?.value;
    const householdCookie = req.cookies.get(HOUSEHOLD_KEY)?.value;
    const verifiedSession = verifyVerifiedSessionValue(verified, userId);
    const authCookieOptions = sessionCookieOptions(maxAge, req);
    if (verifiedSession.ok) {
      const sessionUser = await prisma.user.findUnique({
        where: { id: verifiedSession.userId },
        select: { authVersion: true },
      });
      response.cookies.set(
        VERIFIED_KEY,
        createVerifiedSessionValue(
          verifiedSession.userId,
          maxAge,
          sessionUser?.authVersion ?? verifiedSession.authVersion,
        ),
        authCookieOptions,
      );
    }
    if (userId) response.cookies.set(USER_ID_KEY, userId, authCookieOptions);
    if (username) response.cookies.set(USERNAME_KEY, username, authCookieOptions);
    if (householdCookie) response.cookies.set(HOUSEHOLD_KEY, householdCookie, authCookieOptions);

    return response;
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: "PREFERENCES_WRITE_FAILED", error: error instanceof Error ? error.message : "保存设置失败" },
      { status: 500 },
    );
  }
}
