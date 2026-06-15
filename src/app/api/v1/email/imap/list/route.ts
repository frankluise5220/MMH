import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { closeImap, connectAndOpenBox, listMails } from "@/lib/mail/imap-client";
import { prisma } from "@/lib/db/prisma";

export const runtime = "nodejs";

const BodySchema = z.object({
  accountId: z.string().optional(),
  host: z.string().optional(),
  port: z.number().int().min(1).max(65535).default(993),
  secure: z.boolean().default(true),
  user: z.string().optional(),
  password: z.string().optional(),
  mailbox: z.string().min(1).default("INBOX"),
  limit: z.number().int().min(1).max(50).default(10),
  subjectIncludes: z.string().optional(),
  fromIncludes: z.string().optional(),
  debug: z.boolean().optional(),
});

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as unknown;
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ ok: false, error: "参数格式不正确" }, { status: 400 });

  let { host, port, secure, user, password, mailbox, limit, subjectIncludes, fromIncludes, debug } = parsed.data;

  if (parsed.data.accountId) {
    const account = await prisma.emailAccount.findUnique({ where: { id: parsed.data.accountId } });
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
  let imap: Awaited<ReturnType<typeof connectAndOpenBox>>["imap"] | null = null;

  try {
    const opened = await connectAndOpenBox({ host, port, secure, user, password, mailbox }, trace);
    imap = opened.imap;
    const items = await listMails(imap, { limit, subjectIncludes, fromIncludes }, trace);
    return NextResponse.json({ ok: true, items, mailbox: opened.mailbox, ...(debug ? { trace: [...trace, `list ok ${items.length}`] } : {}) });
  } catch (e) {
    const rawMsg = e instanceof Error ? e.message : "邮箱连接失败";
    return NextResponse.json({ ok: false, error: rawMsg, ...(debug ? { trace: [...trace, `error: ${rawMsg}`] } : {}) }, { status: 500 });
  } finally {
    if (imap) await closeImap(imap);
  }
}