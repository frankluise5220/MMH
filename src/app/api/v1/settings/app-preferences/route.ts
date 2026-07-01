import { NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_CREDIT_CARD_LABEL_TEMPLATE,
  FULL_NAME_CREDIT_CARD_LABEL_TEMPLATE,
  normalizeCreditCardLabelTemplate,
} from "@/lib/account-display";

const SESSION_DAYS_KEY = "mmh_session_days";
const FUND_UNITS_DECIMALS_KEY = "mmh_fund_units_decimals";
const AI_PANEL_ENABLED_KEY = "mmh_ai_panel_enabled";
const TIME_ZONE_MODE_KEY = "mmh_time_zone_mode";
const TIME_ZONE_KEY = "mmh_time_zone";
const CREDIT_CARD_LABEL_MODE_KEY = "mmh_credit_card_label_mode";
const CREDIT_CARD_LABEL_TEMPLATE_KEY = "mmh_credit_card_label_template";
const CREDIT_BILL_HIDE_ZERO_KEY = "mmh_credit_hide_zero_bills";
const CREDIT_BILL_HIDE_SETTLED_KEY = "mmh_credit_hide_settled_bills";
const CREDIT_BILL_RECENT_CYCLES_KEY = "mmh_credit_recent_cycles";
const VERIFIED_KEY = "mmh_access_password_verified";
const USERNAME_KEY = "mmh_username";
const HOUSEHOLD_KEY = "householdId";

function normalizeSessionDays(input: unknown) {
  const n = Number(input);
  if (!Number.isFinite(n)) return 30;
  return Math.min(Math.max(Math.round(n), 1), 365);
}

function normalizeFundUnitsDecimals(input: unknown) {
  const n = Number(input);
  if (!Number.isFinite(n)) return 2;
  return Math.min(Math.max(Math.round(n), 0), 6);
}

function normalizeBoolean(input: unknown, fallback: boolean) {
  if (typeof input === "boolean") return input;
  if (typeof input === "string") {
    if (input === "true" || input === "1") return true;
    if (input === "false" || input === "0") return false;
  }
  return fallback;
}

function normalizeTimeZoneMode(input: unknown) {
  return input === "specified" ? "specified" : "system";
}

function normalizeTimeZone(input: unknown) {
  const value = String(input ?? "").trim();
  if (!value) return "Asia/Shanghai";
  try {
    new Intl.DateTimeFormat("zh-CN", { timeZone: value }).format(new Date());
    return value;
  } catch {
    return "Asia/Shanghai";
  }
}

function normalizeCreditCardLabelMode(input: unknown) {
  return input === "full_name" ? "full_name" : "short_last4";
}

export async function GET(req: NextRequest) {
  const sessionDays = normalizeSessionDays(req.cookies.get(SESSION_DAYS_KEY)?.value ?? 30);
  const fundUnitsDecimals = normalizeFundUnitsDecimals(req.cookies.get(FUND_UNITS_DECIMALS_KEY)?.value ?? 2);
  const aiPanelEnabled = normalizeBoolean(req.cookies.get(AI_PANEL_ENABLED_KEY)?.value, true);
  const timeZoneMode = normalizeTimeZoneMode(req.cookies.get(TIME_ZONE_MODE_KEY)?.value);
  const timeZone = normalizeTimeZone(req.cookies.get(TIME_ZONE_KEY)?.value);
  const creditCardLabelMode = normalizeCreditCardLabelMode(req.cookies.get(CREDIT_CARD_LABEL_MODE_KEY)?.value);
  const creditCardLabelTemplate = normalizeCreditCardLabelTemplate(
    req.cookies.get(CREDIT_CARD_LABEL_TEMPLATE_KEY)?.value,
    creditCardLabelMode,
  );
  const creditBillHideZero = normalizeBoolean(req.cookies.get(CREDIT_BILL_HIDE_ZERO_KEY)?.value, false);
  const creditBillHideSettled = normalizeBoolean(req.cookies.get(CREDIT_BILL_HIDE_SETTLED_KEY)?.value, false);
  const creditBillShowRecentCycles = normalizeBoolean(req.cookies.get(CREDIT_BILL_RECENT_CYCLES_KEY)?.value, true);
  return NextResponse.json({
    ok: true,
    sessionDays,
    fundUnitsDecimals,
    aiPanelEnabled,
    timeZoneMode,
    timeZone,
    creditCardLabelMode,
    creditCardLabelTemplate,
    creditBillHideZero,
    creditBillHideSettled,
    creditBillShowRecentCycles,
  });
}

export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const prefs = body && typeof body === "object" ? body as {
    sessionDays?: unknown;
    fundUnitsDecimals?: unknown;
    aiPanelEnabled?: unknown;
    timeZoneMode?: unknown;
    timeZone?: unknown;
    creditCardLabelMode?: unknown;
    creditCardLabelTemplate?: unknown;
    creditBillHideZero?: unknown;
    creditBillHideSettled?: unknown;
    creditBillShowRecentCycles?: unknown;
  } : {};
  const hasSessionDays = Object.prototype.hasOwnProperty.call(prefs, "sessionDays");
  const hasFundUnitsDecimals = Object.prototype.hasOwnProperty.call(prefs, "fundUnitsDecimals");
  const hasAiPanelEnabled = Object.prototype.hasOwnProperty.call(prefs, "aiPanelEnabled");
  const hasTimeZoneMode = Object.prototype.hasOwnProperty.call(prefs, "timeZoneMode");
  const hasTimeZone = Object.prototype.hasOwnProperty.call(prefs, "timeZone");
  const hasCreditCardLabelMode = Object.prototype.hasOwnProperty.call(prefs, "creditCardLabelMode");
  const hasCreditCardLabelTemplate = Object.prototype.hasOwnProperty.call(prefs, "creditCardLabelTemplate");
  const hasCreditBillHideZero = Object.prototype.hasOwnProperty.call(prefs, "creditBillHideZero");
  const hasCreditBillHideSettled = Object.prototype.hasOwnProperty.call(prefs, "creditBillHideSettled");
  const hasCreditBillShowRecentCycles = Object.prototype.hasOwnProperty.call(prefs, "creditBillShowRecentCycles");
  const sessionDays = normalizeSessionDays(hasSessionDays ? prefs.sessionDays : req.cookies.get(SESSION_DAYS_KEY)?.value ?? 30);
  const fundUnitsDecimals = normalizeFundUnitsDecimals(hasFundUnitsDecimals ? prefs.fundUnitsDecimals : req.cookies.get(FUND_UNITS_DECIMALS_KEY)?.value ?? 2);
  const aiPanelEnabled = normalizeBoolean(hasAiPanelEnabled ? prefs.aiPanelEnabled : req.cookies.get(AI_PANEL_ENABLED_KEY)?.value, true);
  const timeZoneMode = normalizeTimeZoneMode(hasTimeZoneMode ? prefs.timeZoneMode : req.cookies.get(TIME_ZONE_MODE_KEY)?.value);
  const timeZone = normalizeTimeZone(hasTimeZone ? prefs.timeZone : req.cookies.get(TIME_ZONE_KEY)?.value);
  const creditCardLabelMode = normalizeCreditCardLabelMode(hasCreditCardLabelMode ? prefs.creditCardLabelMode : req.cookies.get(CREDIT_CARD_LABEL_MODE_KEY)?.value);
  const creditCardLabelTemplate = normalizeCreditCardLabelTemplate(
    hasCreditCardLabelTemplate ? prefs.creditCardLabelTemplate : req.cookies.get(CREDIT_CARD_LABEL_TEMPLATE_KEY)?.value,
    creditCardLabelMode,
  );
  const creditBillHideZero = normalizeBoolean(
    hasCreditBillHideZero ? prefs.creditBillHideZero : req.cookies.get(CREDIT_BILL_HIDE_ZERO_KEY)?.value,
    false,
  );
  const creditBillHideSettled = normalizeBoolean(
    hasCreditBillHideSettled ? prefs.creditBillHideSettled : req.cookies.get(CREDIT_BILL_HIDE_SETTLED_KEY)?.value,
    false,
  );
  const creditBillShowRecentCycles = normalizeBoolean(
    hasCreditBillShowRecentCycles ? prefs.creditBillShowRecentCycles : req.cookies.get(CREDIT_BILL_RECENT_CYCLES_KEY)?.value,
    true,
  );
  const maxAge = sessionDays * 24 * 60 * 60;

  const response = NextResponse.json({
    ok: true,
    sessionDays,
    fundUnitsDecimals,
    aiPanelEnabled,
    timeZoneMode,
    timeZone,
    creditCardLabelMode,
    creditCardLabelTemplate,
    creditBillHideZero,
    creditBillHideSettled,
    creditBillShowRecentCycles,
  });
  response.cookies.set(SESSION_DAYS_KEY, String(sessionDays), {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: false,
    sameSite: "lax",
  });
  response.cookies.set(FUND_UNITS_DECIMALS_KEY, String(fundUnitsDecimals), {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: false,
    sameSite: "lax",
  });
  response.cookies.set(AI_PANEL_ENABLED_KEY, String(aiPanelEnabled), {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: false,
    sameSite: "lax",
  });
  response.cookies.set(TIME_ZONE_MODE_KEY, timeZoneMode, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: false,
    sameSite: "lax",
  });
  response.cookies.set(TIME_ZONE_KEY, timeZone, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: false,
    sameSite: "lax",
  });
  response.cookies.set(CREDIT_CARD_LABEL_MODE_KEY, creditCardLabelMode, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: false,
    sameSite: "lax",
  });
  response.cookies.set(CREDIT_CARD_LABEL_TEMPLATE_KEY, creditCardLabelTemplate, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: false,
    sameSite: "lax",
  });
  response.cookies.set(CREDIT_BILL_HIDE_ZERO_KEY, creditBillHideZero ? "1" : "0", {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: false,
    sameSite: "lax",
  });
  response.cookies.set(CREDIT_BILL_HIDE_SETTLED_KEY, creditBillHideSettled ? "1" : "0", {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: false,
    sameSite: "lax",
  });
  response.cookies.set(CREDIT_BILL_RECENT_CYCLES_KEY, creditBillShowRecentCycles ? "1" : "0", {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: false,
    sameSite: "lax",
  });

  const verified = req.cookies.get(VERIFIED_KEY)?.value;
  const username = req.cookies.get(USERNAME_KEY)?.value;
  const householdId = req.cookies.get(HOUSEHOLD_KEY)?.value;
  if (verified === "ok") {
    response.cookies.set(VERIFIED_KEY, verified, {
      path: "/",
      maxAge,
      httpOnly: true,
      sameSite: "lax",
    });
  }
  if (username) {
    response.cookies.set(USERNAME_KEY, username, {
      path: "/",
      maxAge,
      httpOnly: false,
      sameSite: "lax",
    });
  }
  if (householdId) {
    response.cookies.set(HOUSEHOLD_KEY, householdId, {
      path: "/",
      maxAge,
      httpOnly: false,
      sameSite: "lax",
    });
  }

  return response;
}
