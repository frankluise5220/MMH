import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { createHash } from "node:crypto";
import type { Readable } from "stream";
import { extractPdfText } from "@/lib/mail/pdf";
import { extractSpreadsheetText } from "@/lib/mail/spreadsheet";

type ImapConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  mailbox?: string;
};

type MailListItem = { uid: number; subject: string; from: string; date: string; hash: string };
export type MailAttachment = { id: string; filename: string; contentType: string; size: number; text?: string; parseError?: string };
export type MailDetail = { uid: number; subject: string; from: string; date: string; text: string; html: string; attachments: MailAttachment[] };
export type MailListMeta = {
  total: number;
  scanned: number;
  matched: number;
  limited: number;
  hasKeyword: boolean;
  scanLimit: number;
  sinceDate: string;
  endDate: string;
  searchMode?: "imap" | "scan";
  timingMs?: {
    connect?: number;
    list?: number;
    total?: number;
  };
};

type MailClient = {
  client: InstanceType<typeof ImapFlow>;
  mailbox: string;
};

type DownloadedMail = {
  content: Readable;
};

type SearchObject = {
  subject?: string;
  from?: string;
  since?: Date | string;
  before?: Date | string;
  or?: SearchObject[];
  all?: boolean;
};

const IMAP_OPERATION_TIMEOUT_MS = 15000;
const IMAP_CLIENT_NAME = "MMH";
/** 一轮 FETCH 取多少封 envelope。200 封/轮在常见邮箱上 100~300ms。 */
const MAIL_FETCH_CHUNK_SIZE = 200;
/**
 * 一次「取邮件列表」最多翻多少封 envelope。
 *
 * 导入关键词默认是中文（「账单」），不能可靠地下推给 IMAP SEARCH（非 ASCII 需要 CHARSET UTF-8，
 * 不少服务端直接回 BAD），所以实际做法是「服务端按日期筛 → 本地按关键词筛」，
 * 本地能筛多少就取决于这个预算。旧实现固定只翻最近 50 封，于是日期范围设到 8 月
 * 也只能在最近 50 封里找，永远翻不到一个月以前的账单邮件。
 */
const MAIL_SCAN_ENVELOPE_BUDGET = 3000;
/** 列表动作的整体时间预算：客户端 20s 就会 abort，这里留足余量。 */
const MAIL_LIST_TIME_BUDGET_MS = 12000;

type MailListFilters = {
  limit: number;
  keywords: string[];
  subjectKeyword?: string;
  fromKeyword?: string;
  sinceValid?: Date | null;
  beforeValid?: Date | null;
};

function buildClient(config: ImapConfig) {
  return new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.user,
      pass: config.password,
    },
    clientInfo: {
      name: IMAP_CLIENT_NAME,
      version: "1.0.0",
    },
    logger: false,
    tls: {
      servername: config.host,
      minVersion: "TLSv1.2",
    },
    socketTimeout: IMAP_OPERATION_TIMEOUT_MS,
    connectionTimeout: IMAP_OPERATION_TIMEOUT_MS,
    greetingTimeout: IMAP_OPERATION_TIMEOUT_MS,
  });
}

function withTimeout<T>(task: Promise<T>, message: string, timeoutMs = IMAP_OPERATION_TIMEOUT_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([task, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function toIso(value: Date | string | undefined) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function normalizeHashPart(value: string | number | undefined | null) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function buildMailListHash(input: { subject: string; from: string; date: string }) {
  const payload = [
    normalizeHashPart(input.subject),
    normalizeHashPart(input.from),
    normalizeHashPart(input.date),
  ].join("\n");
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function formatAddress(address?: { name?: string; address?: string }[]) {
  const first = address?.[0];
  return (first?.address || first?.name || "").trim();
}

type MailEnvelopeMessage = {
  uid: number;
  envelope?: {
    subject?: string | null;
    from?: Array<{ name?: string | null; address?: string | null }> | null;
    date?: Date | string | null;
  } | null;
};

function buildMailListItem(message: MailEnvelopeMessage) {
  const subject = (message.envelope?.subject || "").trim();
  const from = formatAddress(message.envelope?.from?.map((item) => ({
    name: item.name ?? undefined,
    address: item.address ?? undefined,
  })));
  const date = toIso(message.envelope?.date ?? undefined);
  return {
    uid: message.uid,
    subject,
    from,
    date,
    hash: buildMailListHash({ subject, from, date }),
  } satisfies MailListItem;
}

function mailListItemMatchesFilters(
  item: MailListItem,
  filters: {
    keywords: string[];
    subjectKeyword?: string;
    fromKeyword?: string;
    sinceValid?: Date | null;
    beforeValid?: Date | null;
  },
) {
  if (filters.sinceValid || filters.beforeValid) {
    const date = item.date ? new Date(item.date) : null;
    if (date && !Number.isNaN(date.getTime())) {
      if (filters.sinceValid && date < filters.sinceValid) return false;
      if (filters.beforeValid && date >= filters.beforeValid) return false;
    }
  }
  const normalizedSubject = item.subject.toLowerCase();
  const normalizedFrom = item.from.toLowerCase();
  const keywordOk = filters.keywords.length === 0 || filters.keywords.some((keyword) => normalizedSubject.includes(keyword) || normalizedFrom.includes(keyword));
  const subjectOk = !filters.subjectKeyword || normalizedSubject.includes(filters.subjectKeyword);
  const fromOk = !filters.fromKeyword || normalizedFrom.includes(filters.fromKeyword);
  return keywordOk && subjectOk && fromOk;
}

function orSearchQueries(queries: SearchObject[]) {
  if (queries.length === 0) return null;
  if (queries.length === 1) return queries[0];
  return { or: queries } satisfies SearchObject;
}

function buildMailSearchQuery(input: {
  includeText: boolean;
  keywords: string[];
  subjectKeyword?: string;
  fromKeyword?: string;
  sinceValid?: Date | null;
  beforeValid?: Date | null;
}) {
  const query: SearchObject = {};
  if (input.sinceValid) query.since = input.sinceValid;
  if (input.beforeValid) query.before = input.beforeValid;

  if (input.includeText) {
    if (input.keywords.length > 0) {
      const keywordQuery = orSearchQueries(input.keywords.flatMap((keyword) => [
        { subject: keyword } satisfies SearchObject,
        { from: keyword } satisfies SearchObject,
      ]));
      if (keywordQuery?.or) query.or = keywordQuery.or;
      else if (keywordQuery) Object.assign(query, keywordQuery);
    }
    if (input.subjectKeyword) query.subject = input.subjectKeyword;
    if (input.fromKeyword) query.from = input.fromKeyword;
  }

  // 只有中文关键词、又没设日期时没有任何可下推的条件：退化成 ALL，
  // 让服务端把 uid 全给回来、在本地筛，总比只翻最近 50 封强。
  if (Object.keys(query).length === 0) query.all = true;
  return query;
}

/** 按 uid 降序分批取 envelope：命中的收进 rows，够 limit、到预算或超时就停。 */
async function fetchMatchingEnvelopesByUid(
  client: MailClient["client"],
  uids: number[],
  filters: MailListFilters,
  deadline: number,
  trace: string[],
) {
  const rows: MailListItem[] = [];
  let scanned = 0;
  for (let offset = 0; offset < uids.length; offset += MAIL_FETCH_CHUNK_SIZE) {
    if (rows.length >= filters.limit) break;
    if (scanned >= MAIL_SCAN_ENVELOPE_BUDGET) {
      trace.push(`uid fetch budget hit ${scanned}`);
      break;
    }
    if (Date.now() >= deadline) {
      trace.push(`uid fetch deadline hit ${scanned}`);
      break;
    }
    const chunk = uids.slice(offset, offset + MAIL_FETCH_CHUNK_SIZE);
    for await (const message of client.fetch(chunk, { envelope: true, uid: true }, { uid: true })) {
      scanned += 1;
      const item = buildMailListItem(message);
      if (mailListItemMatchesFilters(item, filters)) rows.push(item);
    }
  }
  return { rows, scanned };
}

async function trySearchMailListRows(
  client: MailClient["client"],
  filters: MailListFilters,
  deadline: number,
  trace: string[],
) {
  // 中文关键词（默认就是「账单」）优先下推给 IMAP SEARCH：imapflow 会自动附加
  // CHARSET UTF-8，能直接把几万封收窄到几十封 —— 只有「不带日期」时必须这么做，
  // 否则退化成 ALL，本地翻页会在 12s 预算内被截断（实测 2969 封只翻到 200 封）。
  //
  // 注意 QQ 邮箱有个组合缺陷：`SINCE/BEFORE + SUBJECT 中文` 恒返回空集
  // （实测 8 月窗口内 subject「账单」「兴业」均为 0，而同期只有日期条件时是 49 封）。
  // 所以这里下推返回空集一律再跑一次「只按日期筛」，不把 0 当真结果。
  // 带日期时服务端已把范围收窄，那次本地筛的翻页量很小；不带日期时下推一次就能命中。
  const textTerms = [...filters.keywords, filters.subjectKeyword, filters.fromKeyword].filter(Boolean);
  const plans: Array<{ pushed: boolean; query: SearchObject }> = [];
  if (textTerms.length > 0) {
    plans.push({ pushed: true, query: buildMailSearchQuery({ ...filters, includeText: true }) });
  }
  plans.push({ pushed: false, query: buildMailSearchQuery({ ...filters, includeText: false }) });
  if (!plans[0].pushed) trace.push("search text local only");

  for (let index = 0; index < plans.length; index += 1) {
    const plan = plans[index];
    const isLastPlan = index === plans.length - 1;
    try {
      trace.push(plan.pushed ? "search start (text pushed down)" : "search start");
      const searched = await withTimeout(client.search(plan.query, { uid: true }), "IMAP mail list search timed out");
      if (searched === false) {
        trace.push("search unavailable");
        return null;
      }
      const uids = Array.isArray(searched)
        ? Array.from(new Set(searched.filter((uid) => Number.isFinite(uid)))).sort((a, b) => b - a)
        : [];
      trace.push(`search ok ${uids.length}`);
      // 下推返回空集：可能是服务端不认非 ASCII 匹配，再用不带文本的条件确认一遍。
      if (uids.length === 0) {
        if (!isLastPlan) continue;
        return { items: [] as MailListItem[], matched: 0, scanned: 0, searched: true };
      }

      const { rows, scanned } = await fetchMatchingEnvelopesByUid(client, uids, filters, deadline, trace);
      return {
        items: rows.sort((a, b) => b.uid - a.uid).slice(0, filters.limit),
        matched: rows.length,
        scanned,
        searched: true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      trace.push(`search fallback: ${message}`);
      if (isLastPlan) return null;
    }
  }
  return null;
}

/**
 * 服务端不支持 DATE 检索时的兜底：从最新往里一块一块翻，凑够 limit 就收工。
 * 整块的邮件都比 since 还旧时立刻停 —— 邮箱按到达顺序排列，再往回翻只会更旧。
 */
async function scanRecentMailRows(
  client: MailClient["client"],
  total: number,
  filters: MailListFilters,
  deadline: number,
  trace: string[],
) {
  const rows: MailListItem[] = [];
  let scanned = 0;
  let seqEnd = total;
  while (seqEnd >= 1 && rows.length < filters.limit && scanned < MAIL_SCAN_ENVELOPE_BUDGET && Date.now() < deadline) {
    const chunkSize = Math.min(MAIL_FETCH_CHUNK_SIZE, seqEnd, MAIL_SCAN_ENVELOPE_BUDGET - scanned);
    const seqStart = seqEnd - chunkSize + 1;
    const range = `${seqStart}:${seqEnd}`;
    trace.push(`fetch seq ${range}`);
    let oldestInChunk: Date | null = null;
    for await (const message of client.fetch(range, { envelope: true, uid: true })) {
      scanned += 1;
      const item = buildMailListItem(message);
      const date = item.date ? new Date(item.date) : null;
      if (date && !Number.isNaN(date.getTime()) && (!oldestInChunk || date < oldestInChunk)) oldestInChunk = date;
      if (mailListItemMatchesFilters(item, filters)) rows.push(item);
    }
    if (filters.sinceValid && oldestInChunk && oldestInChunk < filters.sinceValid) break;
    seqEnd = seqStart - 1;
  }
  if (scanned >= MAIL_SCAN_ENVELOPE_BUDGET) trace.push(`scan budget hit ${scanned}`);
  return { rows, scanned };
}

export async function connectAndOpenBox(config: ImapConfig, trace: string[] = []) {
  const mailbox = (config.mailbox ?? "INBOX").trim() || "INBOX";
  const client = buildClient(config);

  trace.push(`connect ${config.host}:${config.port} secure=${config.secure ? "1" : "0"}`);
  try {
    await withTimeout(client.connect(), "IMAP connection timed out");
    trace.push("connect ok");
    await withTimeout(client.mailboxOpen(mailbox, { readOnly: true }), "Mailbox folder open timed out");
    trace.push(`mailbox open ok: ${mailbox}`);
    return { client, mailbox };
  } catch (error) {
    client.close();
    throw error;
  }
}

export async function closeImap(target: MailClient["client"] | MailClient) {
  const client = "client" in target ? target.client : target;
  try {
    if (client.usable) {
      await withTimeout(client.logout(), "IMAP logout timed out", 1000);
    } else {
      client.close();
    }
  } catch {
    client.close();
  }
}

export async function listMails(
  target: MailClient["client"] | MailClient,
  options: { limit: number; scanLimit?: number; sinceDate?: string; endDate?: string; keyword?: string; keywords?: string[]; subjectIncludes?: string; fromIncludes?: string },
  trace: string[] = []
): Promise<{ items: MailListItem[]; meta: MailListMeta }> {
  const client = "client" in target ? target.client : target;
  const total = client.mailbox && typeof client.mailbox.exists === "number" ? client.mailbox.exists : 0;
  trace.push(`box total ${total}`);
  if (!total) {
    return { items: [], meta: { total: 0, scanned: 0, matched: 0, limited: options.limit, hasKeyword: false, scanLimit: options.scanLimit ?? options.limit, sinceDate: options.sinceDate ?? "", endDate: options.endDate ?? "", searchMode: "scan" } };
  }

  const keywords = Array.from(new Set([
    options.keyword,
    ...(options.keywords ?? []),
  ]
    .map((item) => item?.trim().toLowerCase())
    .filter((item): item is string => !!item)));
  const subjectKeyword = options.subjectIncludes?.trim().toLowerCase();
  const fromKeyword = options.fromIncludes?.trim().toLowerCase();
  const hasKeyword = Boolean(keywords.length > 0 || subjectKeyword || fromKeyword);
  const since = options.sinceDate ? new Date(`${options.sinceDate}T00:00:00.000Z`) : null;
  const sinceValid = since && !Number.isNaN(since.getTime()) ? since : null;
  const before = options.endDate ? new Date(`${options.endDate}T00:00:00.000Z`) : null;
  const beforeValid = before && !Number.isNaN(before.getTime())
    ? new Date(before.getTime() + 24 * 60 * 60 * 1000)
    : null;
  const filters: MailListFilters = {
    limit: options.limit,
    keywords,
    subjectKeyword,
    fromKeyword,
    sinceValid,
    beforeValid,
  };
  const deadline = Date.now() + MAIL_LIST_TIME_BUDGET_MS;

  const searchedRows = await trySearchMailListRows(client, filters, deadline, trace);
  if (searchedRows) {
    return {
      items: searchedRows.items,
      meta: {
        total,
        scanned: searchedRows.scanned,
        matched: searchedRows.matched,
        limited: options.limit,
        hasKeyword,
        scanLimit: searchedRows.scanned,
        sinceDate: options.sinceDate ?? "",
        endDate: options.endDate ?? "",
        searchMode: "imap",
      },
    };
  }

  const scannedRows = await withTimeout(
    scanRecentMailRows(client, total, filters, deadline, trace),
    "IMAP mail list read timed out",
  );
  const items = scannedRows.rows.sort((a, b) => b.uid - a.uid).slice(0, options.limit);
  return {
    items,
    meta: {
      total,
      scanned: scannedRows.scanned,
      matched: scannedRows.rows.length,
      limited: options.limit,
      hasKeyword,
      scanLimit: scannedRows.scanned,
      sinceDate: options.sinceDate ?? "",
      endDate: options.endDate ?? "",
      searchMode: "scan",
    },
  };
}

export async function fetchMailDetail(target: MailClient["client"] | MailClient, uid: number) {
  const client = "client" in target ? target.client : target;
  const downloaded = await withTimeout(
    client.download(String(uid), undefined, { uid: true }),
    "IMAP email content read timed out"
  ) as DownloadedMail;
  const chunks: Buffer[] = [];

  await withTimeout(
    new Promise<void>((resolve, reject) => {
      downloaded.content.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      downloaded.content.once("error", reject);
      downloaded.content.once("end", resolve);
    }),
    "IMAP email content download timed out"
  );

  const source = Buffer.concat(chunks);
  if (!source.length) throw new Error("Email content not found.");

  const parsed = await simpleParser(source);
  const attachments = await Promise.all((parsed.attachments ?? []).map(async (attachment, index): Promise<MailAttachment> => {
    const filename = (attachment.filename ?? `Attachment ${index + 1}`).toString();
    const contentType = (attachment.contentType ?? "").toString();
    const content = Buffer.isBuffer(attachment.content) ? attachment.content : Buffer.from(attachment.content ?? []);
    const isPdf = contentType.toLowerCase().includes("pdf") || filename.toLowerCase().endsWith(".pdf");
    const isSpreadsheet = /\.(?:xls|xlsx)$/i.test(filename)
      || /spreadsheet|excel|vnd\.ms-excel|officedocument\.spreadsheetml/i.test(contentType);
    if (!isPdf && !isSpreadsheet) {
      return { id: String(index), filename, contentType, size: attachment.size ?? content.length };
    }

    try {
      const text = isPdf ? await extractPdfText(content) : await extractSpreadsheetText(content);
      return {
        id: String(index),
        filename,
        contentType,
        size: attachment.size ?? content.length,
        text: text || undefined,
        parseError: text ? undefined : isPdf ? "No text was extracted from the PDF." : "No table text was extracted from the spreadsheet.",
      };
    } catch {
      return {
        id: String(index),
        filename,
        contentType,
        size: attachment.size ?? content.length,
        parseError: isPdf ? "PDF text extraction failed. The file may be scanned or encrypted." : "Spreadsheet reading failed. The file may be encrypted or malformed.",
      };
    }
  }));
  return {
    uid,
    subject: (parsed.subject ?? "").toString(),
    from: (parsed.from?.value?.[0]?.address ?? parsed.from?.value?.[0]?.name ?? "").toString(),
    date: toIso(parsed.date),
    text: (parsed.text ?? "").toString(),
    html: (parsed.html ?? "").toString(),
    attachments,
  } satisfies MailDetail;
}
