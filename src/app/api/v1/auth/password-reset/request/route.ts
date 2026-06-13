import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import crypto from "crypto";
import { prisma } from "@/lib/db/prisma";
import { sendPasswordResetEmail } from "@/lib/mail/passwordReset";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

const BodySchema = z.object({
  username: z.string().min(1).max(80),
  email: z.string().email().optional(),
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

async function findTargetUser(params: { username: string; householdId?: string | null }) {
  const username = params.username.trim();
  if (!username) return null;

  const users = await prisma.user.findMany({
    where: { name: username },
    select: { id: true, name: true, email: true, householdId: true, isSystem: true },
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

  const { username, email } = parse.data;
  const cookieHouseholdId = req.cookies.get("householdId")?.value ?? null;
  const user = await findTargetUser({ username, householdId: cookieHouseholdId });

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

  return NextResponse.json({ ok: true, message: "验证码邮件已发送，请检查邮箱收件箱或垃圾邮件。" });
}

