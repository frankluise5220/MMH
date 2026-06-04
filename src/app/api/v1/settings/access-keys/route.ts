import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";

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

export async function GET() {
  const keys = await prisma.accessKey.findMany({
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, key: true, createdAt: true },
  });

  return NextResponse.json({ ok: true, keys }, { headers: cors() });
}

const CreateSchema = z.object({
  name: z.string().min(1).max(80),
  key: z.string().min(4).max(200),
});

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as unknown;
  const parse = CreateSchema.safeParse(body);
  if (!parse.success) {
    return NextResponse.json({ ok: false, error: "缺少必填字段（name/key）" }, { status: 400, headers: cors() });
  }

  const { name, key } = parse.data;

  const created = await prisma.accessKey.create({
    data: { name, key },
    select: { id: true, name: true, key: true, createdAt: true },
  });

  return NextResponse.json({ ok: true, key: created }, { headers: cors() });
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id") ?? "";

  if (!id) {
    return NextResponse.json({ ok: false, error: "缺少 id" }, { status: 400, headers: cors() });
  }

  const existing = await prisma.accessKey.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ ok: false, error: "API Key 不存在" }, { status: 404, headers: cors() });
  }

  await prisma.accessKey.delete({ where: { id } });

  return NextResponse.json({ ok: true }, { headers: cors() });
}