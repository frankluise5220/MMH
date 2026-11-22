import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ALL_MAILBOXES, closeImap, connectAndOpenBox, connectImap, listMails, listMailsAcrossMailboxes, MAIL_LIST_TOTAL_BUDGET_MS } from "@/lib/mail/imap-client";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";

export const runtime = "nodejs";

const MAX_MAIL_SEARCH_LIMIT = 100;
/** 一次查询的日期跨度上限（自然月），与设置页前端同口径。 */
const MAX_MAIL_SEARCH_MONTHS = 3;
const DateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** 起止跨度是否超过 MAX_MAIL_SEARCH_MONTHS 个自然月（正好 3 个月算允许）。 */
function exceedsMailSearchRange(sinceDate: string, endDate: string) {
  const start = new Date(`${sinceDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return false;
  const limitEnd = new Date(start.getTime());
  limitEnd.setUTCMonth(limitEnd.getUTCMonth() + MAX_MAIL_SEARCH_MONTHS);
  return end.getTime() > limitEnd.getTime();
}

/**
 * POST /api/v1/email/imap/list
 *
 * Lists mailbox envelopes for one configured email account or an ad-hoc IMAP
 * configuration. `sinceDate` and `endDate` are date-only bounds in YYYY-MM-DD
 * format, both inclusive from the user's perspective. `limit` and `scanLimit`
 * are capped at 100 and the window at 3 months so the import picker stays bounded.
 */
const BodySchema = z.object({
  accountId: z.string().optional(),
  host: z.string().optional(),
  port: z.number().int().min(1).max(65535).default(993),
  secure: z.boolean().default(true),
  user: z.string().optional(),
  password: z.string().optional(),
  /** 不传则用账户里保存的文件夹；传 "*" 表示先列出文件夹再逐个搜。 */
  mailbox: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(MAX_MAIL_SEARCH_LIMIT).default(MAX_MAIL_SEARCH_LIMIT),
  scanLimit: z.number().int().min(1).max(MAX_MAIL_SEARCH_LIMIT).default(MAX_MAIL_SEARCH_LIMIT),
  sinceDate: DateOnlySchema.optional(),
  endDate: DateOnlySchema.optional(),
  keyword: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  subjectIncludes: z.string().optional(),
  fromIncludes: z.string().optional(),
  debug: z.boolean().optional(),
});

export async function POST(req: NextRequest) {
  const { householdId } = await getHouseholdScope();
  const body = (await req.json().catch(() => null)) as unknown;
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ ok: false, code: "INVALID_REQUEST", error: "Invalid request body." }, { status: 400 });

  let { host, port, secure, user, password, mailbox, limit, scanLimit, sinceDate, endDate, keyword, keywords, subjectIncludes, fromIncludes, debug } = parsed.data;

  if (sinceDate && endDate && sinceDate > endDate) {
    return NextResponse.json({ ok: false, code: "INVALID_DATE_RANGE", error: "Start date must not be later than end date." }, { status: 400 });
  }

  // 只给一端等于放开另一端（只给起始 = 查到现在，只给终止 = 从最早查起），范围不可控。
  if (Boolean(sinceDate) !== Boolean(endDate)) {
    return NextResponse.json({ ok: false, code: "INVALID_DATE_RANGE", error: "Start and end date must be provided together." }, { status: 400 });
  }

  if (sinceDate && endDate && exceedsMailSearchRange(sinceDate, endDate)) {
    return NextResponse.json({ ok: false, code: "DATE_RANGE_TOO_LONG", error: `Date range must not exceed ${MAX_MAIL_SEARCH_MONTHS} months.` }, { status: 400 });
  }

  if (parsed.data.accountId) {
    const account = await prisma.emailAccount.findFirst({ where: { id: parsed.data.accountId, householdId } });
    if (!account) return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: "Email account not found." }, { status: 404 });
    host = account.imapHost;
    port = account.imapPort;
    secure = account.imapSecure;
    user = account.username;
    password = account.password;
    // 请求里显式指定文件夹时以请求为准（"*" = 不限定文件夹），否则用账户里保存的默认文件夹。
    mailbox = parsed.data.mailbox?.trim() || account.mailbox;
  }

  if (!host || !user || !password) {
    return NextResponse.json({ ok: false, code: "INCOMPLETE_CONFIG", error: "Complete IMAP configuration is required." }, { status: 400 });
  }

  const targetMailbox = (mailbox ?? "").trim() || "INBOX";
  const trace: string[] = [];
  let client: Awaited<ReturnType<typeof connectAndOpenBox>>["client"] | null = null;
  const startedAt = Date.now();
  // 建连也算进预算：QQ 邮箱实测建连要 8s，若从 listMails 入口才开始计时，
  // 连接 8s + 列表 12s 正好撞上客户端放弃线，查老账单会稳定超时。
  const deadline = startedAt + MAIL_LIST_TOTAL_BUDGET_MS;
  const listOptions = { limit, scanLimit, sinceDate, endDate, keyword, keywords, subjectIncludes, fromIncludes, deadline };

  try {
    // 不限定文件夹：先列出文件夹，再逐个按同一套条件搜，合并取最新 limit 封。
    if (targetMailbox === ALL_MAILBOXES) {
      const connected = await connectImap({ host, port, secure, user, password }, trace);
      const openedAt = Date.now();
      client = connected.client;
      const result = await listMailsAcrossMailboxes(client, listOptions, trace);
      const listedAt = Date.now();
      return NextResponse.json({
        ok: true,
        items: result.items,
        meta: {
          ...result.meta,
          timingMs: {
            connect: openedAt - startedAt,
            list: listedAt - openedAt,
            total: listedAt - startedAt,
          },
        },
        mailbox: ALL_MAILBOXES,
        ...(debug ? { trace: [...trace, `list ok ${result.items.length}`] } : {}),
      });
    }

    const opened = await connectAndOpenBox({ host, port, secure, user, password, mailbox: targetMailbox }, trace);
    const openedAt = Date.now();
    client = opened.client;
    const result = await listMails(client, listOptions, trace);
    const listedAt = Date.now();
    return NextResponse.json({
      ok: true,
      items: result.items,
      meta: {
        ...result.meta,
        timingMs: {
          connect: openedAt - startedAt,
          list: listedAt - openedAt,
          total: listedAt - startedAt,
        },
      },
      mailbox: opened.mailbox,
      ...(debug ? { trace: [...trace, `list ok ${result.items.length}`] } : {}),
    });
  } catch (e) {
    const rawMsg = e instanceof Error ? e.message : "Mailbox connection failed.";
    return NextResponse.json({ ok: false, code: "IMAP_CONNECT_FAILED", error: formatImapError(rawMsg), ...(debug ? { trace: [...trace, `error: ${rawMsg}`] } : {}) }, { status: 500 });
  } finally {
    if (client) await closeImap(client);
  }
}

function formatImapError(message: string) {
  const lower = message.toLowerCase();
  if (lower.includes("authentication") || lower.includes("login") || lower.includes("auth")) {
    return "Mailbox login failed. Confirm that IMAP is enabled and use an app password instead of the web login password.";
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return "Mailbox connection timed out. Check the IMAP server, port, TLS setting, and network connection.";
  }
  if (lower.includes("mailbox") || lower.includes("not found")) {
    return "Mailbox folder could not be opened. Confirm the folder name; INBOX is usually the first value to try.";
  }
  return message;
}
