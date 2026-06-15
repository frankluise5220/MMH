import { NextResponse } from "next/server";

const COOKIES_TO_CLEAR = [
  "mmh_access_password_verified",
  "mmh_username",
] as const;

export async function POST() {
  const response = NextResponse.json({ ok: true });

  for (const name of COOKIES_TO_CLEAR) {
    response.cookies.set(name, "", {
      path: "/",
      httpOnly: name === "mmh_access_password_verified",
      sameSite: "lax",
      maxAge: 0,
      expires: new Date(0),
    });
  }

  return response;
}
