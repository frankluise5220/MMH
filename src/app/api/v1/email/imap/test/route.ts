import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { closeImap, connectAndOpenBox } from "@/lib/mail/imap-client";

export const runtime = "nodejs";

const BodySchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(993),
  secure: z.boolean().default(true),
  user: z.string().min(1),
  password: z.string().min(1),
  mailbox: z.string().min(1).default("INBOX"),
});

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as unknown;
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ ok: false, error: "参数格式不正确" }, { status: 400 });

  const { host, port, secure, user, password, mailbox } = parsed.data;
  const trace: string[] = [];
  let imap: Awaited<ReturnType<typeof connectAndOpenBox>>["imap"] | null = null;

  try {
    const opened = await connectAndOpenBox({ host, port, secure, user, password, mailbox }, trace);
    imap = opened.imap;
    return NextResponse.json({ ok: true, trace: [...trace, "test ok"], mailbox: opened.mailbox });
  } catch (e) {
    const rawMsg = e instanceof Error ? e.message : "邮箱连接失败";
    return NextResponse.json({ ok: false, error: rawMsg, trace: [...trace, `error: ${rawMsg}`] }, { status: 500 });
  } finally {
    if (imap) await closeImap(imap);
  }
}
