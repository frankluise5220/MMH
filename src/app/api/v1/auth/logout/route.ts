import { NextResponse } from "next/server";
import { SESSION_COOKIES, expiredSessionCookieOptions } from "@/lib/server/session-cookies";

export async function POST() {
  const response = NextResponse.json({ ok: true });
  const options = expiredSessionCookieOptions();

  for (const name of SESSION_COOKIES) {
    response.cookies.set(name, "", options);
  }

  return response;
}
