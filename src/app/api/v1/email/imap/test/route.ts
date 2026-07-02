import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { closeImap, connectAndOpenBox } from "@/lib/mail/imap-client";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";

export const runtime = "nodejs";

const BodySchema = z.object({
  accountId: z.string().optional(),
  host: z.string().optional(),
  port: z.number().int().min(1).max(65535).default(993),
  secure: z.boolean().default(true),
  user: z.string().optional(),
  password: z.string().optional(),
  mailbox: z.string().min(1).default("INBOX"),
});

export async function POST(req: NextRequest) {
  const { householdId } = await getHouseholdScope();
  const body = (await req.json().catch(() => null)) as unknown;
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ ok: false, error: "参数格式不正确" }, { status: 400 });

  let { host, port, secure, user, password, mailbox } = parsed.data;

  // 如果传了 accountId，从数据库读取配置
  if (parsed.data.accountId) {
    const account = await prisma.emailAccount.findFirst({ where: { id: parsed.data.accountId, householdId } });
    if (!account) return NextResponse.json({ ok: false, error: "账户不存在" }, { status: 404 });
    host = account.imapHost;
    port = account.imapPort;
    secure = account.imapSecure;
    user = account.username;
    password = account.password;
    mailbox = account.mailbox;
  }

  if (!host || !user || !password) {
    return NextResponse.json({ ok: false, error: "请填写完整配置" }, { status: 400 });
  }

  const trace: string[] = [];
  let client: Awaited<ReturnType<typeof connectAndOpenBox>>["client"] | null = null;

  try {
    const opened = await connectAndOpenBox({ host, port, secure, user, password, mailbox }, trace);
    client = opened.client;
    return NextResponse.json({ ok: true, trace: [...trace, "test ok"], mailbox: opened.mailbox });
  } catch (e) {
    const rawMsg = e instanceof Error ? e.message : "邮箱连接失败";
    return NextResponse.json({ ok: false, error: rawMsg, trace: [...trace, `error: ${rawMsg}`] }, { status: 500 });
  } finally {
    if (client) await closeImap(client);
  }
}
