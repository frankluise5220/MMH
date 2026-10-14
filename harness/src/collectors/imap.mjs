/**
 * IMAP 采集器：拉取 MMH 反馈邮箱的未读邮件。
 *
 * MMH 反馈邮件格式（见 src/app/api/v1/settings/feedback/route.ts）：
 *   主题：[MMH Bug] / [MMH Feedback] / [MMH Sponsor Tip] + 用户标题
 *   正文：User / Contact / Type / App version + 内容 + "---- Client logs ----" 段
 *   附件：最多 3 张 JPG/PNG/WebP 截图
 *
 * 语义：未读 = 待处理。处理完按 IMAP_MARK_SEEN 决定是否标记已读。
 */

import path from "node:path";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { log } from "../log.mjs";
import { ensureDir, slug, truncate, writeBinaryAtomic } from "../util.mjs";

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

function subjectMatches(cfg, subject) {
  if (!cfg.imap.subjectFilter.length) return true;
  const s = String(subject ?? "");
  return cfg.imap.subjectFilter.some((prefix) => s.toLowerCase().includes(prefix.toLowerCase()));
}

/** 从正文里抠出结构化字段。 */
function parseFeedbackBody(text) {
  const out = { user: "", contact: "", type: "", appVersion: "", content: text ?? "", logs: "" };
  const raw = String(text ?? "");
  const logSplit = raw.split(/^-{2,}\s*Client logs\s*-{2,}\s*$/im);
  const head = logSplit[0] ?? raw;
  out.logs = (logSplit[1] ?? "").trim();

  const lines = head.split(/\r?\n/);
  const contentLines = [];
  for (const line of lines) {
    const m = line.match(/^(User|Contact|Type|App version):\s*(.*)$/i);
    if (m) {
      const key = m[1].toLowerCase();
      if (key === "user") out.user = m[2].trim();
      else if (key === "contact") out.contact = m[2].trim();
      else if (key === "type") out.type = m[2].trim();
      else if (key === "app version") out.appVersion = m[2].trim();
      continue;
    }
    contentLines.push(line);
  }
  out.content = contentLines.join("\n").trim();
  return out;
}

/** 把截图附件落盘到 data/assets/<taskId>/，返回 taskfile 用的附件描述。 */
async function persistAttachments(cfg, taskId, attachments) {
  const saved = [];
  if (!attachments?.length) return saved;
  const dir = path.join(cfg.assetsDir, slug(taskId));
  await ensureDir(dir);
  let index = 0;
  for (const att of attachments) {
    index += 1;
    if (!IMAGE_TYPES.has(att.contentType ?? "")) continue;
    const safeName = `${String(index).padStart(2, "0")}-${slug(att.filename ?? "shot", 50)}`;
    const filename = safeName.includes(".") ? safeName : `${safeName}.png`;
    try {
      await writeBinaryAtomic(path.join(dir, filename), att.content);
      saved.push({
        storedAs: `${slug(taskId)}/${filename}`,
        filename,
        contentType: att.contentType,
        note: "用户上传的截图",
      });
    } catch (error) {
      log.warn(`附件落盘失败 ${filename}: ${error.message}`);
    }
  }
  return saved;
}

/**
 * 拉取一轮 IMAP。返回待处理条目数组。
 * @param {object} cfg
 * @param {import('../store.mjs').Store} store
 */
export async function collectImap(cfg, store) {
  if (!cfg.imap.host || !cfg.imap.user || !cfg.imap.pass) {
    log.warn("未配置 IMAP_HOST / IMAP_USER / IMAP_PASS，跳过邮件采集");
    return [];
  }

  const client = new ImapFlow({
    host: cfg.imap.host,
    port: cfg.imap.port,
    secure: cfg.imap.secure,
    auth: { user: cfg.imap.user, pass: cfg.imap.pass },
    logger: false,
    socketTimeout: 120_000,
  });

  const items = [];
  let lock = null;
  try {
    await client.connect();
    lock = await client.getMailboxLock(cfg.imap.mailbox);
    try {
      let scanned = 0;
      for await (const msg of client.fetch({ seen: false }, { uid: true, source: true })) {
        scanned += 1;
        const parsed = await simpleParser(msg.source);
        const subject = parsed.subject ?? "";
        const messageId = parsed.messageId ?? `uid-${msg.uid}@${cfg.imap.user}`;

        if (!subjectMatches(cfg, subject)) {
          if (cfg.imap.markSeen) await client.messageFlagsAdd(msg.uid, ["\\Seen"], { uid: true });
          continue;
        }
        if (store.isProcessed(`imap:${messageId}`)) {
          if (cfg.imap.markSeen) await client.messageFlagsAdd(msg.uid, ["\\Seen"], { uid: true });
          continue;
        }

        const bodyText = parsed.text ?? (parsed.html ? String(parsed.html).replace(/<[^>]+>/g, " ") : "");
        const parsedBody = parseFeedbackBody(bodyText);
        const taskId = `MAIL-${slug(messageId.replace(/[<>]/g, ""), 40)}`;
        const attachments = await persistAttachments(cfg, taskId, parsed.attachments ?? []);

        const lines = [
          `提交者: ${parsedBody.user || "unknown"}`,
          parsedBody.contact ? `联系方式: ${parsedBody.contact}` : "",
          `反馈类型: ${parsedBody.type || "unknown"}`,
          `App 版本: ${parsedBody.appVersion || "unknown"}`,
          "",
          parsedBody.content,
          parsedBody.logs ? `\n---- Client logs ----\n${parsedBody.logs}` : "",
        ];

        items.push({
          source: "imap",
          externalId: messageId,
          taskId,
          processKey: `imap:${messageId}`,
          title: subject,
          body: truncate(lines.filter((l) => l !== "").join("\n"), 12_000),
          url: "",
          author: parsed.from?.text ?? "",
          meta: {
            user: parsedBody.user,
            contact: parsedBody.contact,
            type: parsedBody.type,
            appVersion: parsedBody.appVersion,
            receivedAt: parsed.date ? parsed.date.toISOString() : "",
          },
          comments: [],
          attachments,
          uid: msg.uid,
          messageId,
        });
      }
      log.info(`IMAP 采集完成：扫描 ${scanned} 封未读，${items.length} 封待处理`);
    } finally {
      lock.release();
      lock = null;
    }
  } catch (error) {
    log.error(`IMAP 采集失败：${error.message}`);
    return items;
  } finally {
    if (lock) {
      try {
        lock.release();
      } catch {
        /* ignore */
      }
    }
    try {
      await client.logout();
    } catch {
      /* ignore */
    }
  }

  store.state.lastImapPollAt = new Date().toISOString();
  store.markDirty();
  return items;
}

/** 处理成功后标记已读（在写库之后调用，保证失败可重试）。 */
export async function markImapSeen(cfg, uids) {
  if (!cfg.imap.markSeen || !uids?.length) return;
  const client = new ImapFlow({
    host: cfg.imap.host,
    port: cfg.imap.port,
    secure: cfg.imap.secure,
    auth: { user: cfg.imap.user, pass: cfg.imap.pass },
    logger: false,
  });
  try {
    await client.connect();
    const lock = await client.getMailboxLock(cfg.imap.mailbox);
    try {
      await client.messageFlagsAdd(uids, ["\\Seen"], { uid: true });
      log.info(`已标记 ${uids.length} 封邮件为已读`);
    } finally {
      lock.release();
    }
  } catch (error) {
    log.warn(`标记已读失败（下次仍会重扫，靠 Message-ID 去重）：${error.message}`);
  } finally {
    try {
      await client.logout();
    } catch {
      /* ignore */
    }
  }
}
