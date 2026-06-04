import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";

export const runtime = "nodejs";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
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

// === Internal: POST (create) ===
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const name = String(body.name ?? "").trim();
    const kind = (typeof body?.kind === "string" ? body.kind.trim() : "other") as any;
    const groupId = String(body.groupId ?? "").trim() || null;
    const institutionId = String(body.institutionId ?? "").trim() || null;
    const currency = String(body.currency ?? "CNY").trim();

    if (!name) return NextResponse.json({ ok: false, error: "名称必填" }, { status: 400 });

    await prisma.account.create({
      data: { name, kind, currency, groupId: groupId || null, institutionId: institutionId || null, isActive: true },
    } as any);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "创建失败" }, { status: 500 });
  }
}

// === Internal: PUT (update) ===
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const id = String(body.id ?? "").trim();
    if (!id) return NextResponse.json({ ok: false, error: "缺少 id" }, { status: 400 });

    const data: Record<string, unknown> = {};
    if (body.name !== undefined) data.name = String(body.name).trim();
    if (body.groupId !== undefined) data.groupId = String(body.groupId).trim() || null;
    if (body.institutionId !== undefined) data.institutionId = String(body.institutionId).trim() || null;

    const parseDay = (raw: unknown) => {
      if (raw === undefined) return undefined;
      const s = String(raw ?? "").trim();
      if (!s) return null;
      const n = Number(s);
      if (!Number.isFinite(n) || n < 1 || n > 31) return undefined;
      return n;
    };
    if (body.billingDay !== undefined) data.billingDay = parseDay(body.billingDay);
    if (body.repaymentDay !== undefined) data.repaymentDay = parseDay(body.repaymentDay);
    if (body.creditLimit !== undefined) data.creditLimit = String(body.creditLimit ?? "").trim() || null;
    if (body.numberMasked !== undefined) data.numberMasked = String(body.numberMasked ?? "").trim() || null;

    await prisma.account.update({ where: { id }, data });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "更新失败" }, { status: 500 });
  }
}

// === Internal: PATCH (toggle active) ===
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const id = String(body.id ?? "").trim();
    if (!id) return NextResponse.json({ ok: false, error: "缺少 id" }, { status: 400 });

    const existing = await prisma.account.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ ok: false, error: "账户不存在" }, { status: 404 });

    await prisma.account.update({ where: { id }, data: { isActive: !existing.isActive } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "操作失败" }, { status: 500 });
  }
}

// === Internal: DELETE ===
export async function DELETE(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ ok: false, error: "缺少 id" }, { status: 400 });

    const used = await prisma.txRecord.count({ where: { accountId: id } });
    if (used > 0) return NextResponse.json({ ok: false, error: "该账户已产生流水记录，无法删除" }, { status: 409 });

    await prisma.account.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "删除失败" }, { status: 500 });
  }
}

// === External: GET (summaries, requires API key) ===
export async function GET(req: Request) {
  if (!requireApiKey(req).ok) {
    return NextResponse.json({ ok: false, error: "未授权" }, { status: 401, headers: corsHeaders() });
  }

  const rows = await prisma.txRecord.groupBy({
    by: ["accountName"],
    _sum: { amount: true },
    _count: { _all: true },
  });

  const accounts = rows
    .map((r) => ({ name: r.accountName, balance: toNumber(r._sum.amount), count: r._count._all }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));

  return NextResponse.json({ ok: true, accounts }, { headers: corsHeaders() });
}
