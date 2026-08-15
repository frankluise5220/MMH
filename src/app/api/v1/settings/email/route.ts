import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";

export const runtime = "nodejs";

const BodySchema = z.object({
  // IMAP 收件
  emailHost: z.string().optional(),
  emailPort: z.number().optional(),
  emailSecure: z.boolean().optional(),
  emailUser: z.string().optional(),
  emailPassword: z.string().optional(),
  emailMailbox: z.string().optional(),
  // SMTP 发件
  smtpHost: z.string().optional(),
  smtpPort: z.number().optional(),
  smtpSecure: z.boolean().optional(),
  smtpUser: z.string().optional(),
  smtpPass: z.string().optional(),
  smtpFrom: z.string().optional(),
  // Resend 发件
  resendApiKey: z.string().optional(),
  resendFrom: z.string().optional(),
  // 功能开关
  passwordResetEnabled: z.boolean().optional(),
});

/**
 * 旧版邮箱设置接口（仅管理员）。
 *
 * 当前界面已改用 /api/v1/settings/email-accounts；此接口仍被邮件发送回退链路
 * （smtp.ts / resend.ts 读取 userSettings）使用，因此保留但必须：
 * 1. 仅管理员可读写；
 * 2. 不再信任 x-user-id 请求头（避免任意用户身份冒充）；
 * 3. GET 不回传明文密码 / API Key，只返回是否已设置。
 */
async function requireAdminUserId(): Promise<{ ok: true; userId: string } | { ok: false; response: NextResponse }> {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return { ok: false, response: NextResponse.json({ ok: false, error: "请先登录" }, { status: 401 }) };
  }
  if (!isAdmin(currentUser)) {
    return { ok: false, response: NextResponse.json({ ok: false, error: "仅管理员可操作" }, { status: 403 }) };
  }
  return { ok: true, userId: currentUser.id };
}

export async function POST(req: Request) {
  const auth = await requireAdminUserId();
  if (!auth.ok) return auth.response;

  const body = (await req.json().catch(() => null)) as unknown;
  const parse = BodySchema.safeParse(body);
  if (!parse.success) {
    return NextResponse.json({ ok: false, error: "参数不正确" }, { status: 400 });
  }

  const data = parse.data;
  await prisma.userSettings.upsert({
    where: { userId: auth.userId },
    update: {
      emailHost: data.emailHost,
      emailPort: data.emailPort,
      emailSecure: data.emailSecure,
      emailUser: data.emailUser,
      emailPassword: data.emailPassword,
      emailMailbox: data.emailMailbox,
      smtpHost: data.smtpHost,
      smtpPort: data.smtpPort,
      smtpSecure: data.smtpSecure,
      smtpUser: data.smtpUser,
      smtpPass: data.smtpPass,
      smtpFrom: data.smtpFrom,
      resendApiKey: data.resendApiKey,
      resendFrom: data.resendFrom,
      passwordResetEnabled: data.passwordResetEnabled,
    },
    create: {
      userId: auth.userId,
      emailHost: data.emailHost,
      emailPort: data.emailPort,
      emailSecure: data.emailSecure,
      emailUser: data.emailUser,
      emailPassword: data.emailPassword,
      emailMailbox: data.emailMailbox,
      smtpHost: data.smtpHost,
      smtpPort: data.smtpPort,
      smtpSecure: data.smtpSecure,
      smtpUser: data.smtpUser,
      smtpPass: data.smtpPass,
      smtpFrom: data.smtpFrom,
      resendApiKey: data.resendApiKey,
      resendFrom: data.resendFrom,
      passwordResetEnabled: data.passwordResetEnabled,
    },
  });

  return NextResponse.json({ ok: true });
}

export async function GET() {
  const auth = await requireAdminUserId();
  if (!auth.ok) return auth.response;

  const settings = await prisma.userSettings.findUnique({
    where: { userId: auth.userId },
  });

  return NextResponse.json({
    ok: true,
    data: settings
      ? {
          emailHost: settings.emailHost,
          emailPort: settings.emailPort,
          emailSecure: settings.emailSecure,
          emailUser: settings.emailUser,
          emailPasswordSet: !!settings.emailPassword,
          emailMailbox: settings.emailMailbox,
          smtpHost: settings.smtpHost,
          smtpPort: settings.smtpPort,
          smtpSecure: settings.smtpSecure,
          smtpUser: settings.smtpUser,
          smtpPassSet: !!settings.smtpPass,
          smtpFrom: settings.smtpFrom,
          resendApiKeySet: !!settings.resendApiKey,
          resendFrom: settings.resendFrom,
          passwordResetEnabled: settings.passwordResetEnabled,
        }
      : null,
  });
}
