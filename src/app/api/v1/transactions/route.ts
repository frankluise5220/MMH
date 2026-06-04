import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";

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

  const url = new URL(req.url);
  const accountName = (url.searchParams.get("accountName") ?? "").trim();
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "200") || 200, 1), 1000);

  const entries = await prisma.txRecord.findMany({
    where: accountName ? { accountName } : undefined,
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    take: limit,
  });

  const items = entries.map((e) => ({
    id: e.id,
    transactionId: e.id,
    date: e.date.toISOString(),
    type: e.type,
    amount: e.amount,
    accountName: e.accountName,
    categoryName: e.categoryName,
    note: e.note,
    counterparty: null,
    sourceText: null,
  }));

  return NextResponse.json(
    {
      ok: true,
      items,
    },
    { headers: corsHeaders() },
  );
}

