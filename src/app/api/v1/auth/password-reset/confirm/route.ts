import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import crypto from "crypto";
import { prisma } from "@/lib/db/prisma";
import { hashPassword } from "@/lib/auth/password";

export const runtime = "nodejs";

const BodySchema = z.object({
  username: z.string().min(1).max(80),
  code: z.string().min(4).max(20),
  newPassword: z.string().min(6).max(200),
});

async function findTargetUser(params: { username: string; householdId?: string | null }) {
  const username = params.username.trim();
  if (!username) return null;

  const users = await prisma.user.findMany({
    where: { name: username },
    select: { id: true, name: true, householdId: true, isSystem: true },
  });

  if (users.length === 0) return null;

  const byCookie = params.householdId
    ? users.find((u) => u.householdId === params.householdId) ?? null
    : null;
  if (byCookie) return byCookie;

  if (users.length === 1) return users[0]!;

  if (username === "admin") {
    return users.find((u) => u.isSystem) ?? null;
  }

  return null;
}

function hashCode(params: { userId: string; code: string }) {
  const secret = (process.env.PASSWORD_RESET_SECRET ?? "").trim();
  if (!secret) return null;
  return crypto.createHash("sha256").update(`${secret}:${params.userId}:${params.code}`).digest("hex");
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as unknown;
  const parse = BodySchema.safeParse(body);
  if (!parse.success) {
    return NextResponse.json({ ok: false, error: "参数不正确" }, { status: 400 });
  }

  const secret = (process.env.PASSWORD_RESET_SECRET ?? "").trim();
  if (!secret) {
    return NextResponse.json({ ok: false, error: "未配置密码找回功能" }, { status: 500 });
  }

  const { username, code, newPassword } = parse.data;
  const cookieHouseholdId = req.cookies.get("householdId")?.value ?? null;
  const user = await findTargetUser({ username, householdId: cookieHouseholdId });
  if (!user) {
    return NextResponse.json({ ok: false, error: "验证码无效或已过期" }, { status: 400 });
  }

  const tokenHash = hashCode({ userId: user.id, code: code.trim() });
  if (!tokenHash) {
    return NextResponse.json({ ok: false, error: "未配置密码找回功能" }, { status: 500 });
  }

  const token = await prisma.passwordResetToken.findFirst({
    where: {
      userId: user.id,
      tokenHash,
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });

  if (!token) {
    return NextResponse.json({ ok: false, error: "验证码无效或已过期" }, { status: 400 });
  }

  const passwordHash = await hashPassword(newPassword.trim());

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { passwordHash },
    });
    await tx.passwordResetToken.update({
      where: { id: token.id },
      data: { usedAt: new Date() },
    });
  });

  return NextResponse.json({ ok: true });
}

