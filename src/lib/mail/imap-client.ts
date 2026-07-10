import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { createHash } from "node:crypto";
import type { Readable } from "stream";
import { extractPdfText } from "@/lib/mail/pdf";

export type ImapConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  mailbox?: string;
};

export type MailListItem = { uid: number; subject: string; from: string; date: string; hash: string };
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
};

type MailClient = {
  client: InstanceType<typeof ImapFlow>;
  mailbox: string;
};

type DownloadedMail = {
  content: Readable;
};

const IMAP_OPERATION_TIMEOUT_MS = 15000;
const IMAP_CLIENT_NAME = "MMH";

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

function buildRecentSequenceRange(total: number, limit: number, hasKeyword: boolean, scanLimit?: number) {
  const requestedScanLimit = scanLimit && Number.isFinite(scanLimit) ? Math.max(1, Math.floor(scanLimit)) : 0;
  const effectiveScanLimit = requestedScanLimit > 0
    ? Math.max(limit, requestedScanLimit)
    : hasKeyword
      ? Math.max(limit * 100, 500)
      : limit;
  const scanLimitClamped = Math.min(total, effectiveScanLimit);
  const start = Math.max(1, total - scanLimitClamped + 1);
  return `${start}:${total}`;
}

export async function connectAndOpenBox(config: ImapConfig, trace: string[] = []) {
  const mailbox = (config.mailbox ?? "INBOX").trim() || "INBOX";
  const client = buildClient(config);

  trace.push(`connect ${config.host}:${config.port} secure=${config.secure ? "1" : "0"}`);
  try {
    await withTimeout(client.connect(), "IMAP 连接超时");
    trace.push("connect ok");
    await withTimeout(client.mailboxOpen(mailbox, { readOnly: true }), "邮箱文件夹打开超时");
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
      await withTimeout(client.logout(), "IMAP 退出超时", 1000);
    } else {
      client.close();
    }
  } catch {
    client.close();
  }
}

export async function listMails(
  target: MailClient["client"] | MailClient,
  options: { limit: number; scanLimit?: number; sinceDate?: string; keyword?: string; keywords?: string[]; subjectIncludes?: string; fromIncludes?: string },
  trace: string[] = []
): Promise<{ items: MailListItem[]; meta: MailListMeta }> {
  const client = "client" in target ? target.client : target;
  const total = client.mailbox && typeof client.mailbox.exists === "number" ? client.mailbox.exists : 0;
  trace.push(`box total ${total}`);
  if (!total) {
    return { items: [], meta: { total: 0, scanned: 0, matched: 0, limited: options.limit, hasKeyword: false, scanLimit: options.scanLimit ?? options.limit, sinceDate: options.sinceDate ?? "" } };
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
  const range = buildRecentSequenceRange(total, options.limit, hasKeyword || Boolean(sinceValid), options.scanLimit);
  let scanned = 0;
  trace.push(`fetch seq ${range}`);

  const rows: MailListItem[] = [];
  const task = (async () => {
    for await (const message of client.fetch(range, { envelope: true, uid: true })) {
      const subject = (message.envelope?.subject || "无主题").trim();
      const from = formatAddress(message.envelope?.from);
      const date = message.envelope?.date instanceof Date ? message.envelope.date : null;
      if (sinceValid && date && date < sinceValid) {
        continue;
      }
      scanned += 1;
      const normalizedSubject = subject.toLowerCase();
      const normalizedFrom = from.toLowerCase();
      const keywordOk = keywords.length === 0 || keywords.some((keyword) => normalizedSubject.includes(keyword) || normalizedFrom.includes(keyword));
      const subjectOk = !subjectKeyword || normalizedSubject.includes(subjectKeyword);
      const fromOk = !fromKeyword || normalizedFrom.includes(fromKeyword);

      if (!keywordOk || !subjectOk || !fromOk) {
        trace.push(`filter uid=${message.uid} "${subject}" "${from}"`);
        continue;
      }

      rows.push({
        uid: message.uid,
        subject,
        from,
        date: toIso(message.envelope?.date),
        hash: buildMailListHash({ subject, from, date: toIso(message.envelope?.date) }),
      });
      trace.push(`row ok uid=${message.uid} "${subject}"`);
    }
  })();

  await withTimeout(task, "IMAP 读取邮件列表超时");
  const items = rows.sort((a, b) => b.uid - a.uid).slice(0, options.limit);
  return {
    items,
    meta: {
      total,
      scanned,
      matched: rows.length,
      limited: options.limit,
      hasKeyword,
      scanLimit: options.scanLimit ?? scanned,
      sinceDate: options.sinceDate ?? "",
    },
  };
}

export async function fetchMailDetail(target: MailClient["client"] | MailClient, uid: number) {
  const client = "client" in target ? target.client : target;
  const downloaded = await withTimeout(
    client.download(String(uid), undefined, { uid: true }),
    "IMAP 读取邮件内容超时"
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
    "IMAP 下载邮件内容超时"
  );

  const source = Buffer.concat(chunks);
  if (!source.length) throw new Error("未找到邮件内容");

  const parsed = await simpleParser(source);
  const attachments = await Promise.all((parsed.attachments ?? []).map(async (attachment, index): Promise<MailAttachment> => {
    const filename = (attachment.filename ?? `附件${index + 1}`).toString();
    const contentType = (attachment.contentType ?? "").toString();
    const content = Buffer.isBuffer(attachment.content) ? attachment.content : Buffer.from(attachment.content ?? []);
    const isPdf = contentType.toLowerCase().includes("pdf") || filename.toLowerCase().endsWith(".pdf");
    if (!isPdf) {
      return { id: String(index), filename, contentType, size: attachment.size ?? content.length };
    }

    try {
      const text = await extractPdfText(content);
      return {
        id: String(index),
        filename,
        contentType,
        size: attachment.size ?? content.length,
        text: text || undefined,
        parseError: text ? undefined : "PDF 未提取到文字",
      };
    } catch {
      return {
        id: String(index),
        filename,
        contentType,
        size: attachment.size ?? content.length,
        parseError: "PDF 文字提取失败，可能是扫描件或加密文件",
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
