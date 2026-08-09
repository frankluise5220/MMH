import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";

const PUBLIC_SETTING_KEYS = new Set(["allowed_dev_origins", "origin_check_enabled"]);

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const keysParam = searchParams.get("keys")?.trim();
  if (keysParam) {
    const keys = Array.from(new Set(keysParam.split(",").map((key) => key.trim()).filter(Boolean)));
    if (keys.length === 0) return NextResponse.json({ ok: false, error: "缺少 key" }, { status: 400 });
    const needsAdmin = keys.some((key) => !PUBLIC_SETTING_KEYS.has(key));
    if (needsAdmin) {
      const user = await getCurrentUser();
      if (!isAdmin(user)) {
        return NextResponse.json({ ok: false, error: "仅管理员可读取该设置" }, { status: 403 });
      }
    }
    const rows = await prisma.systemSetting.findMany({ where: { key: { in: keys } } });
    const values = Object.fromEntries(keys.map((key) => [key, rows.find((row) => row.key === key)?.value ?? null]));
    return NextResponse.json({ ok: true, values });
  }

  const key = searchParams.get("key")?.trim();
  if (!key) return NextResponse.json({ ok: false, error: "缺少 key" }, { status: 400 });
  const isPublicKey = PUBLIC_SETTING_KEYS.has(key);
  if (!isPublicKey) {
    const user = await getCurrentUser();
    if (!isAdmin(user)) {
      return NextResponse.json({ ok: false, error: "仅管理员可读取该设置" }, { status: 403 });
    }
  }
  const row = await prisma.systemSetting.findUnique({ where: { key } });
  return NextResponse.json({ ok: true, value: row?.value ?? null });
}

export async function POST(req: NextRequest) {
  const { key, value } = await req.json();
  if (!key) return NextResponse.json({ ok: false, error: "缺少 key" }, { status: 400 });
  const user = await getCurrentUser();
  if (!isAdmin(user)) {
    return NextResponse.json({ ok: false, error: "仅管理员可修改系统设置" }, { status: 403 });
  }
  await prisma.systemSetting.upsert({
    where: { key },
    create: { key, value: String(value ?? "") },
    update: { value: String(value ?? "") },
  });
  return NextResponse.json({ ok: true });
}
