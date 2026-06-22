import { NextRequest, NextResponse } from "next/server";

const SESSION_DAYS_KEY = "mmh_session_days";
const FUND_UNITS_DECIMALS_KEY = "mmh_fund_units_decimals";
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

export async function GET(req: NextRequest) {
  const sessionDays = normalizeSessionDays(req.cookies.get(SESSION_DAYS_KEY)?.value ?? 30);
  const fundUnitsDecimals = normalizeFundUnitsDecimals(req.cookies.get(FUND_UNITS_DECIMALS_KEY)?.value ?? 2);
  return NextResponse.json({ ok: true, sessionDays, fundUnitsDecimals });
}

export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const prefs = body && typeof body === "object" ? body as { sessionDays?: unknown; fundUnitsDecimals?: unknown } : {};
  const hasSessionDays = Object.prototype.hasOwnProperty.call(prefs, "sessionDays");
  const hasFundUnitsDecimals = Object.prototype.hasOwnProperty.call(prefs, "fundUnitsDecimals");
  const sessionDays = normalizeSessionDays(hasSessionDays ? prefs.sessionDays : req.cookies.get(SESSION_DAYS_KEY)?.value ?? 30);
  const fundUnitsDecimals = normalizeFundUnitsDecimals(hasFundUnitsDecimals ? prefs.fundUnitsDecimals : req.cookies.get(FUND_UNITS_DECIMALS_KEY)?.value ?? 2);
  const maxAge = sessionDays * 24 * 60 * 60;

  const response = NextResponse.json({ ok: true, sessionDays, fundUnitsDecimals });
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
