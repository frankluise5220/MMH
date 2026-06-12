import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";

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
});

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as unknown;
  const parse = BodySchema.safeParse(body);
  if (!parse.success) {
    return NextResponse.json({ ok: false, error: "参数不正确" }, { status: 400 });
  }

  const data = parse.data;

  // 开发环境：获取第一个用户或创建默认用户
  let userId = req.headers.get("x-user-id");
  if (!userId) {
    const users = await prisma.user.findMany({ take: 1 });
    if (users[0]?.id) {
      userId = users[0].id;
    } else {
      const newUser = await prisma.user.create({ data: { name: "默认用户" } });
      userId = newUser.id;
    }
  }

  await prisma.userSettings.upsert({
    where: { userId },
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
    },
    create: {
      userId,
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
    },
  });

  return NextResponse.json({ ok: true });
}

export async function GET(req: Request) {
  // 开发环境：获取第一个用户或创建默认用户
  let userId = new URL(req.url).searchParams.get("userId");
  if (!userId) {
    const users = await prisma.user.findMany({ take: 1 });
    if (users[0]?.id) {
      userId = users[0].id;
    } else {
      const newUser = await prisma.user.create({ data: { name: "默认用户" } });
      userId = newUser.id;
    }
  }

  const settings = await prisma.userSettings.findUnique({
    where: { userId },
  });

  return NextResponse.json({
    ok: true,
    data: settings ? {
      emailHost: settings.emailHost,
      emailPort: settings.emailPort,
      emailSecure: settings.emailSecure,
      emailUser: settings.emailUser,
      emailPassword: settings.emailPassword,
      emailMailbox: settings.emailMailbox,
      smtpHost: settings.smtpHost,
      smtpPort: settings.smtpPort,
      smtpSecure: settings.smtpSecure,
      smtpUser: settings.smtpUser,
      smtpPass: settings.smtpPass,
      smtpFrom: settings.smtpFrom,
      resendApiKey: settings.resendApiKey,
      resendFrom: settings.resendFrom,
    } : null,
  });
}