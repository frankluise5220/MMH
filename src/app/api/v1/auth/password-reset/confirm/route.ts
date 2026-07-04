import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import crypto from "crypto";
import { prisma } from "@/lib/db/prisma";
import { hashPassword } from "@/lib/auth/password";
import { getHouseholdDisplayName } from "@/lib/household-display";

export const runtime = "nodejs";

const BodySchema = z.object({
  username: z.string().min(1).max(80),
  code: z.string().min(4).max(20),
  newPassword: z.string().min(6).max(200),
  householdId: z.string().min(1).optional(),
});

type ResetUser = {
  id: string;
  name: string;
  householdId: string | null;
  Household: { id: string; name: string } | null;
};

function householdChoicesForUsers(users: ResetUser[]) {
  const seen = new Set<string>();
  return users
    .map((user) => ({
      id: user.householdId,
      name: getHouseholdDisplayName({ id: user.householdId, name: user.Household?.name }, "未命名账簿"),
    }))
    .filter((household): household is { id: string; name: string } => {
      if (!household.id || seen.has(household.id)) return false;
      seen.add(household.id);
      return true;
    });
}

async function findCandidateUsers(params: { username: string; householdId?: string | null }) {
  const username = params.username.trim();
  if (!username) return [];

  const users = await prisma.user.findMany({
    where: { name: username },
    select: { id: true, name: true, householdId: true, Household: { select: { id: true, name: true } } },
  });

  if (users.length === 0) return [];

  const byCookie = params.householdId
    ? users.find((u) => u.householdId === params.householdId) ?? null
    : null;
  if (byCookie) return [byCookie];

  if (users.length === 1) return users;

  return users;
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

  const { username, code, newPassword, householdId } = parse.data;
  const cookieHouseholdId = householdId ?? req.cookies.get("householdId")?.value ?? null;
  const users = await findCandidateUsers({ username, householdId: cookieHouseholdId });
  if (users.length === 0) {
    return NextResponse.json({ ok: false, error: "验证码无效或已过期" }, { status: 400 });
  }

  const tokenMatches: Array<{ user: ResetUser; tokenId: string }> = [];
  for (const user of users) {
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
    if (token) tokenMatches.push({ user, tokenId: token.id });
  }

  if (tokenMatches.length === 0) {
    return NextResponse.json({ ok: false, error: "验证码无效或已过期" }, { status: 400 });
  }
  if (tokenMatches.length > 1 && !cookieHouseholdId) {
    return NextResponse.json(
      {
        ok: false,
        code: "AMBIGUOUS_USER",
        error: "该验证码匹配多个账簿，请选择要重置的账簿",
        households: householdChoicesForUsers(tokenMatches.map((match) => match.user)),
      },
      { status: 409 },
    );
  }

  const passwordHash = await hashPassword(newPassword.trim());
  const { user, tokenId } = tokenMatches[0];

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { passwordHash },
    });
    await tx.passwordResetToken.update({
      where: { id: tokenId },
      data: { usedAt: new Date() },
    });
  });

  return NextResponse.json({ ok: true });
}
