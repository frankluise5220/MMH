import { NextResponse } from "next/server";

export function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    // X-Api-Key is the header advertised in the docs and accepted by
    // getApiHouseholdScope; omitting it made browser preflight reject the
    // header even though the server would have accepted it.
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
  } as const;
}

export function joinBaseUrl(baseUrl: string, path: string) {
  const base = baseUrl.replace(/\/$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  if (base.endsWith("/v1") && p.startsWith("/v1/")) return `${base}${p.slice(3)}`;
  if (base.endsWith("/v1") && p.startsWith("/api/")) return `${base.slice(0, -3)}${p}`;
  return `${base}${p}`;
}
