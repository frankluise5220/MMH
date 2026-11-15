import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ImapFlow } from "imapflow";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { isAdmin } from "@/lib/server/auth";

export const runtime = "nodejs";

const BodySchema = z.object({
  /** 已保存账户：编辑时密码框是空的，用库里的授权码连一次以列出文件夹。 */
  accountId: z.string().min(1).optional(),
  host: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  secure: z.boolean().optional(),
  user: z.string().optional(),
  password: z.string().optional(),
});

/**
 * POST /api/v1/email/imap/mailboxes
 *
 * Connects to the given IMAP server and lists mailboxes (admin only).
 * This endpoint starts a server-side connection using the host/port/credentials
 * provided by the caller; allowing anonymous use would turn it into an
 * intranet-scan/credential-testing proxy, so admin authentication is required.
 */
export async function POST(req: NextRequest) {
  const { householdId, user: currentUser } = await getHouseholdScope();
  if (!currentUser) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "请先登录" }, { status: 401 });
  }
  if (!isAdmin(currentUser)) {
    return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "仅管理员可操作" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as unknown;
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST", error: "参数格式不正确" }, { status: 400 });
  }

  const input = parsed.data;
  const saved = input.accountId
    ? await prisma.emailAccount.findFirst({
      where: { id: input.accountId, householdId },
      select: { imapHost: true, imapPort: true, imapSecure: true, username: true, password: true },
    })
    : null;

  const host = (input.host ?? saved?.imapHost ?? "").trim();
  const port = input.port ?? saved?.imapPort ?? 993;
  const secure = input.secure ?? saved?.imapSecure ?? true;
  const user = (input.user ?? saved?.username ?? "").trim();
  // 编辑已保存账户时表单里的密码是空的，回落用库里的授权码，否则只能让用户重填一次。
  const password = (input.password ?? "").trim() || saved?.password || "";

  if (!host || !user || !password) {
    return NextResponse.json({ ok: false, code: "INCOMPLETE_CONFIG", error: "请先填写 IMAP 主机、邮箱账号与授权码，再读取文件夹列表" }, { status: 400 });
  }

  const trace: string[] = [];

  const client = new ImapFlow({
    host,
    port,
    secure,
    auth: { user, pass: password, loginMethod: "LOGIN" },
    logger: false,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
    disableAutoEnable: true,
    disableCompression: true,
    disableBinary: true,
    disableAutoIdle: true,
    tls: secure ? { minVersion: "TLSv1.2", servername: host } : undefined,
  });

  try {
    trace.push(`connect ${host}:${port} secure=${secure ? "1" : "0"}`);
    await client.connect();
    trace.push("connect ok");

    const boxes: string[] = [];
    const anyClient = client as unknown as {
      list?: () => Promise<unknown> | AsyncIterable<unknown>;
      listTree?: () => Promise<unknown> | AsyncIterable<unknown>;
    };

    async function collectFrom(source: unknown) {
      if (!source) return;
      if (typeof (source as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function") {
        for await (const box of source as AsyncIterable<{ path?: string; name?: string }>) {
          const path = (box.path ?? box.name ?? "").toString();
          if (path) boxes.push(path);
        }
        return;
      }
      if (Array.isArray(source)) {
        for (const box of source as Array<{ path?: string; name?: string }>) {
          const path = (box.path ?? box.name ?? "").toString();
          if (path) boxes.push(path);
        }
      }
    }

    if (typeof anyClient.list === "function") {
      await collectFrom(await anyClient.list());
    }
    if (!boxes.length && typeof anyClient.listTree === "function") {
      await collectFrom(await anyClient.listTree());
    }

    if (!boxes.length) {
      boxes.push("INBOX", "Inbox", "收件箱");
    }

    const unique = Array.from(new Set(boxes));
    trace.push(`mailbox list ok: ${unique.length}`);
    return NextResponse.json({ ok: true, trace, mailboxes: unique.slice(0, 200) });
  } catch (e) {
    // imapflow 对登录失败只抛 `Command failed`，真正的原因（NO Invalid login…）
    // 在 responseText 里；不还原这句，用户只会以为是网络问题。
    const failure = (e ?? {}) as { message?: string; code?: string; responseText?: string; authenticationFailed?: boolean };
    const serverText = (failure.responseText ?? "").trim();
    const rawMsg = failure.message ?? "邮箱连接失败";
    const lower = `${failure.code ?? ""} ${rawMsg} ${serverText}`.toLowerCase();
    const msg = failure.authenticationFailed || serverText
      ? `认证失败：${serverText || "请确认邮箱账号与授权码是否正确"}。IMAP 通常要用邮箱设置里单独生成的授权码/独立密码，不是网页登录密码。`
      : lower.includes("auth") || lower.includes("login")
        ? "认证失败：请确认邮箱账号与授权码是否正确。IMAP 通常要用邮箱设置里单独生成的授权码/独立密码。"
        : lower.includes("timed out") || lower.includes("timeout")
          ? "连接超时：请检查网络、端口与TLS设置。"
          : lower.includes("enotfound")
            ? "域名解析失败：请检查IMAP主机地址是否正确。"
            : rawMsg;
    return NextResponse.json({ ok: false, code: "IMAP_CONNECT_FAILED", error: msg, trace: [...trace, `error: ${rawMsg}${serverText ? ` :: ${serverText}` : ""}`] }, { status: 500 });
  } finally {
    try {
      await client.logout();
    } catch {}
  }
}
