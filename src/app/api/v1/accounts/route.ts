import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";

export const runtime = "nodejs";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
  } as const;
}

function getProvidedApiKey(req: Request) {
  const auth = req.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const key = req.headers.get("x-api-key");
  return key?.trim() || null;
}

function requireApiKey(req: Request) {
  const required = (process.env.STATEMENT_API_KEY ?? "").trim();
  if (!required) return { ok: true as const };
  const provided = getProvidedApiKey(req);
  if (!provided || provided !== required) return { ok: false as const };
  return { ok: true as const };
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export async function GET(req: Request) {
  if (!requireApiKey(req).ok) {
    return NextResponse.json(
      { ok: false, error: "未授权" },
      { status: 401, headers: corsHeaders() },
    );
  }

  const rows = await prisma.txRecord.groupBy({
    by: ["accountName"],
    _sum: { amount: true },
    _count: { _all: true },
  });

  const accounts = rows
    .map((r) => ({
      name: r.accountName,
      balance: toNumber(r._sum.amount),
      count: r._count._all,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));

  return NextResponse.json(
    {
      ok: true,
      accounts,
    },
    { headers: corsHeaders() },
  );
}
