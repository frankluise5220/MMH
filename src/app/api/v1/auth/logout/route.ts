import { NextResponse } from "next/server";

export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.delete("wiseme_access_password_verified");
  response.cookies.delete("wiseme_username");
  return response;
}
