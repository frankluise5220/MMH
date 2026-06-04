import Imap from "imap";
import { simpleParser } from "mailparser";

export type ImapConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  mailbox?: string;
};

export type MailListItem = { uid: number; subject: string; from: string; date: string };
export type MailDetail = { uid: number; subject: string; from: string; date: string; text: string; html: string };

function buildImap(config: ImapConfig) {
  return new Imap({
    user: config.user,
    password: config.password,
    host: config.host,
    port: config.port,
    tls: config.secure,
    autotls: "never",
    tlsOptions: { servername: config.host, minVersion: "TLSv1.2" } as object,
    connTimeout: 15000,
    authTimeout: 15000,
    keepalive: { interval: 30000, idleThreshold: 10000 },
  });
}

function parseAddress(raw: string) {
  const m = raw.match(/<([^>]+)>/);
  return (m?.[1] ?? raw).trim();
}

function toIso(v: Date | string | undefined) {
  if (!v) return "";
  if (v instanceof Date) return v.toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

export async function connectAndOpenBox(config: ImapConfig, trace: string[]) {
  const mailbox = (config.mailbox ?? "INBOX").trim() || "INBOX";
  const imap = buildImap(config);

  return await new Promise<{ imap: Imap; mailbox: string }>((resolve, reject) => {
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      try {
        imap.end();
      } catch {}
      reject(err);
    };

    trace.push(`connect ${config.host}:${config.port} secure=${config.secure ? "1" : "0"}`);

    imap.once("error", (err) => fail(err));

    imap.once("ready", () => {
      trace.push("connect ok");
      new Promise<void>((resolve) => {
        try {
          const imapWithId = imap as Imap & { id: (info: object, cb: (err: Error | null) => void) => void };
          imapWithId.id({ name: "node-imap", version: "1.0.0" }, (err: Error | null) => {
            if (err) { trace.push("id err: " + err.message); }
            else { trace.push("id ok"); }
            resolve();
          });
        } catch (e) {
          trace.push("id skipped: " + (e instanceof Error ? e.message : String(e)));
          resolve();
        }
      }).then(() => {
        trace.push(`mailbox open try: ${mailbox}`);
        imap.openBox(mailbox, true, (err) => {
          if (err) return fail(err);
          if (settled) return;
          settled = true;
          trace.push(`mailbox open ok: ${mailbox}`);
          resolve({ imap, mailbox });
        });
      });
    });

    imap.connect();
  });
}

export async function closeImap(imap: Imap) {
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    imap.once("end", finish);
    imap.once("close", finish);
    try {
      imap.end();
    } catch {
      finish();
    }
    setTimeout(finish, 1000);
  });
}

export async function listMails(
  imap: Imap,
  options: { limit: number; subjectIncludes?: string; fromIncludes?: string },
  trace: string[] = []
) {
  const total = (imap as unknown as { _box?: { messages?: { total?: number } } })._box?.messages?.total ?? 0;
  trace.push(`total ${total}`);
  if (!total) return [] as MailListItem[];

  const start = Math.max(1, total - options.limit + 1);
  const range = `${start}:${total}`;
  trace.push(`range ${range}`);

  const rows: MailListItem[] = [];
  const seenUids = new Set<number>();

  await new Promise<void>((resolve, reject) => {
    const f = imap.seq.fetch(range, { bodies: "HEADER.FIELDS (SUBJECT FROM DATE)", struct: false });
    let pending = 0;

    f.on("message", (msg) => {
      pending++;
      let uid = 0;
      let subject = "";
      let from = "";
      let date = "";

      msg.on("attributes", (attrs) => {
        uid = Number(attrs.uid ?? 0);
      });

      msg.on("body", (stream) => {
        let buf = "";
        stream.on("data", (chunk) => {
          buf += chunk.toString("utf8");
        });
        stream.on("end", () => {
          const parsed = Imap.parseHeader(buf);
          subject = (parsed.subject?.[0] ?? "无主题").toString().trim();
          from = parseAddress((parsed.from?.[0] ?? "").toString());
          date = toIso((parsed.date?.[0] ?? "").toString());
        });
      });

      msg.once("end", () => {
        pending--;
        if (!uid || seenUids.has(uid)) return;
        seenUids.add(uid);
        const subjectOk = !options.subjectIncludes || subject.includes(options.subjectIncludes);
        const fromOk = !options.fromIncludes || from.includes(options.fromIncludes);
        if (!subjectOk) { trace.push(`filter subject: uid=${uid} "${subject}"`); return; }
        if (!fromOk) { trace.push(`filter from: uid=${uid} "${from}"`); return; }
        rows.push({ uid, subject, from, date });
        trace.push(`row ok uid=${uid} "${subject}"`);
        if (pending === 0) resolve();
      });
    });

    f.on("error", (e) => {
      trace.push(`fetch err: ${e instanceof Error ? e.message : String(e)}`);
      reject(e);
    });
    f.on("end", () => {
      trace.push(`fetch end rows=${rows.length}`);
      resolve();
    });
  });

  return rows.sort((a, b) => b.uid - a.uid);
}

export async function fetchMailDetail(imap: Imap, uid: number) {
  return await new Promise<MailDetail>((resolve, reject) => {
    let done = false;
    const f = imap.fetch(uid, { bodies: "" });

    f.on("message", (msg) => {
      let messageUid = uid;
      let source = Buffer.alloc(0);

      msg.on("attributes", (attrs) => {
        messageUid = Number(attrs.uid ?? uid);
      });

      msg.on("body", (stream) => {
        const chunks: Buffer[] = [];
        stream.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        stream.on("end", () => {
          source = Buffer.concat(chunks);
        });
      });

      msg.once("end", async () => {
        if (done) return;
        try {
          const parsed = await simpleParser(source);
          done = true;
          resolve({
            uid: messageUid,
            subject: (parsed.subject ?? "").toString(),
            from: (parsed.from?.value?.[0]?.address ?? parsed.from?.value?.[0]?.name ?? "").toString(),
            date: toIso(parsed.date),
            text: (parsed.text ?? "").toString(),
            html: (parsed.html ?? "").toString(),
          });
        } catch (e) {
          done = true;
          reject(e);
        }
      });
    });

    f.once("error", (e) => {
      if (done) return;
      done = true;
      reject(e);
    });

    f.once("end", () => {
      if (!done) reject(new Error("未找到邮件内容"));
    });
  });
}
