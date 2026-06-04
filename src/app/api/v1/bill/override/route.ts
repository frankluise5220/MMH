import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { revalidateAfterTxChange } from "@/lib/server/revalidate";

export const runtime = "nodejs";

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  } as const;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: cors() });
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const accountId = searchParams.get("accountId") ?? "";
  const statementMonth = searchParams.get("statementMonth") ?? "";
  if (!accountId || !statementMonth) {
    return NextResponse.json({ ok: true, overrides: [] }, { headers: cors() });
  }
  const overrides = await prisma.billOverride.findMany({
    where: { accountId, statementMonth: { startsWith: statementMonth.slice(0, 7) } },
    orderBy: { statementMonth: "desc" },
  });
  return NextResponse.json({ ok: true, overrides }, { headers: cors() });
}

const SaveSchema = z.object({
  accountId: z.string(),
  statementMonth: z.string(),
  amount: z.number(),
  note: z.string().optional(),
});

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as unknown;
    const parse = SaveSchema.safeParse(body);
    if (!parse.success) {
      return NextResponse.json({ ok: false, error: "缺少必填字段" }, { status: 400, headers: cors() });
    }
    const { accountId, statementMonth, amount, note } = parse.data;
    const existing = await prisma.billOverride.findFirst({
      where: { accountId, statementMonth },
    });
    let override;
    if (existing) {
      override = await prisma.billOverride.update({
        where: { id: existing.id },
        data: { amount: String(amount), note },
      });
    } else {
      override = await prisma.billOverride.create({
        data: { accountId, statementMonth, amount: String(amount), note },
      });
    }
    revalidateAfterTxChange();
    return NextResponse.json({ ok: true, override }, { headers: cors() });
  } catch (err) {
    console.error("[bill/override POST]", err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500, headers: cors() });
  }
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const accountId = searchParams.get("accountId") ?? "";
  const statementMonth = searchParams.get("statementMonth") ?? "";
  if (!accountId || !statementMonth) {
    return NextResponse.json({ ok: false, error: "缺少参数" }, { status: 400, headers: cors() });
  }

  const existing = await prisma.billOverride.findFirst({
    where: { accountId, statementMonth },
  });
  if (!existing) {
    return NextResponse.json({ ok: false, error: "账单覆盖记录不存在" }, { status: 404, headers: cors() });
  }

  await prisma.billOverride.delete({ where: { id: existing.id } });
  revalidateAfterTxChange();
  return NextResponse.json({ ok: true }, { headers: cors() });
}