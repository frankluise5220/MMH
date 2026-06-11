import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const key = searchParams.get("key")?.trim();
  if (!key) return NextResponse.json({ ok: false, error: "缺少 key" }, { status: 400 });
  const row = await prisma.systemSetting.findUnique({ where: { key } });
  return NextResponse.json({ ok: true, value: row?.value ?? null });
}

export async function POST(req: NextRequest) {
  const { key, value } = await req.json();
  if (!key) return NextResponse.json({ ok: false, error: "缺少 key" }, { status: 400 });
  await prisma.systemSetting.upsert({
    where: { key },
    create: { key, value: String(value ?? "") },
    update: { value: String(value ?? "") },
  });
  return NextResponse.json({ ok: true });
}
