import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import crypto from "crypto";
import { prisma } from "@/lib/db/prisma";
import { sendPasswordResetEmail } from "@/lib/mail/passwordReset";
import { logger } from "@/lib/logger";
import { getHouseholdDisplayName } from "@/lib/household-display";

export const runtime = "nodejs";

const BodySchema = z.object({
  username: z.string().min(1).max(80),
  email: z.string().email().optional(),
  householdId: z.string().min(1).optional(),
});

function getClientIp(req: NextRequest) {
  const xf = req.headers.get("x-forwarded-for");
  if (xf) return xf.split(",")[0]?.trim() || null;
  const xr = req.headers.get("x-real-ip");
  if (xr) return xr.trim() || null;
  return null;
}

function normalizeEmail(v: string) {
  return v.trim().toLowerCase();
}

type ResetUser = {
  id: string;
  name: string;
  email: string | null;
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

async function findTargetUser(params: { username: string; email?: string | null; householdId?: string | null }) {
  const username = params.username.trim();
  if (!username) return null;
  const providedEmail = params.email ? normalizeEmail(params.email) : null;

  const users = await prisma.user.findMany({
    where: { name: username },
    select: { id: true, name: true, email: true, householdId: true, Household: { select: { id: true, name: true } } },
  });

  if (users.length === 0) return null;

  const byCookie = params.householdId
    ? users.find((u) => u.householdId === params.householdId) ?? null
    : null;
  if (byCookie) return byCookie;

  if (!providedEmail && users.length > 1) return null;

  const emailMatches = providedEmail
    ? users.filter((u) => u.email && normalizeEmail(u.email) === providedEmail)
    : users;

  if (emailMatches.length === 0) return null;
  if (emailMatches.length === 1) return emailMatches[0]!;

  return NextResponse.json(
    {
      ok: false,
      code: "AMBIGUOUS_USER",
      error: "该用户名和邮箱匹配多个账簿，请选择要找回的账簿",
      households: householdChoicesForUsers(emailMatches),
    },
    { status: 409 },
  );
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

  const { username, email, householdId } = parse.data;
  const cookieHouseholdId = householdId ?? req.cookies.get("householdId")?.value ?? null;
  const user = await findTargetUser({ username, email, householdId: cookieHouseholdId });
  if (user instanceof NextResponse) {
    return user;
  }

  const ip = getClientIp(req);
  const userAgent = req.headers.get("user-agent") ?? null;

  const response = NextResponse.json({
    ok: true,
    message: "如果该用户已绑定邮箱，将收到一封验证码邮件。",
  });

  const userEmail = user?.email ? normalizeEmail(user.email) : null;
  const providedEmail = email ? normalizeEmail(email) : null;
  if (!user || !userEmail || (providedEmail && userEmail !== providedEmail)) {
    return response;
  }

  const now = Date.now();
  const windowStart = new Date(now - 60 * 60 * 1000);
  const [userRecent, ipRecent] = await Promise.all([
    prisma.passwordResetToken.count({ where: { userId: user.id, createdAt: { gt: windowStart } } }),
    ip ? prisma.passwordResetToken.count({ where: { ip, createdAt: { gt: windowStart } } }) : Promise.resolve(0),
  ]);
  if (userRecent >= 3 || ipRecent >= 10) {
    return response;
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const tokenHash = hashCode({ userId: user.id, code });
  if (!tokenHash) {
    return NextResponse.json({ ok: false, error: "未配置密码找回功能" }, { status: 500 });
  }

  const expiresMinutes = 15;
  const expiresAt = new Date(now + expiresMinutes * 60 * 1000);

  const created = await prisma.passwordResetToken.create({
    data: { userId: user.id, tokenHash, expiresAt, ip: ip ?? undefined, userAgent: userAgent ?? undefined },
    select: { id: true },
  });

  try {
    const mailRes = await sendPasswordResetEmail({
      to: userEmail,
      username: user.name,
      code,
      expiresMinutes,
    });
    if (!mailRes.ok) {
      await prisma.passwordResetToken.delete({ where: { id: created.id } }).catch(logger.catchSilent("删除未发送验证码", "password-reset"));
      logger.warn(mailRes.error || "验证码发送失败", "password-reset");
      return NextResponse.json({ ok: false, error: mailRes.error }, { status: 500 });
    }
  } catch (error) {
    await prisma.passwordResetToken.delete({ where: { id: created.id } }).catch(logger.catchSilent("删除发送失败验证码", "password-reset"));
    logger.error("验证码邮件发送失败", "password-reset", error);
    return NextResponse.json({ ok: false, error: "验证码邮件发送失败，请检查 SMTP 配置或邮箱授权码" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, message: "验证码邮件已发送，请检查邮箱收件箱或垃圾邮件。", householdId: user.householdId });
}
