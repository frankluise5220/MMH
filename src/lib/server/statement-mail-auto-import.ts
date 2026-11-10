import { prisma } from "@/lib/db/prisma";
import { addDaysUtc, formatDateInTimeZone } from "@/lib/date-utils";
import { getHouseholdTimeZone } from "@/lib/server/household-preferences";
import { closeImap, connectAndOpenBox, fetchMailDetail, listMails, type MailDetail } from "@/lib/mail/imap-client";
import { logger } from "@/lib/logger";

/**
 * 邮箱账单「下期自动导入」的执行器。
 *
 * 用户在某封银行账单上勾选「下期自动导入」后落一条 StatementMailAutoImport 计划
 * （邮箱 + 目标账户 + 发件人/主题筛选 + 每月执行日）。system-task 定时器按
 * `nextRunAt` 触发这里：连 IMAP → 在最近一个账单周期里找同一家银行的下期邮件 →
 * 把正文与附件文字原文存成 StatementMailAutoImportJob（pending）。
 *
 * 关键约束：**绝不自动落账**。账单金额/分类必须由用户确认，所以这里只负责
 * 「把下期账单取回来」；通知栏提示后，用户在导入预览里点确认才写流水。
 */

/** 检索窗口：账单通常是月度的，40 天足以覆盖上期末到本期的空档。 */
const SEARCH_WINDOW_DAYS = 40;
/** 一次执行最多看多少封邮件（IMAP 扫描上限 50）。 */
const MAIL_SCAN_LIMIT = 20;
/** 失败后重试间隔：不把整月的机会浪费在凌晨那次网络抖动上。 */
const RETRY_DELAY_MS = 12 * 60 * 60 * 1000;

export type MailAutoImportScheduleInput = {
  emailAccountId: string;
  accountId?: string | null;
  accountName?: string | null;
  fromIncludes?: string | null;
  subjectIncludes?: string | null;
  dayOfMonth?: number | null;
  hourOfDay?: number | null;
  enabled?: boolean | null;
};

export function normalizeAutoImportDayOfMonth(value: unknown): number {
  const n = Math.trunc(Number(value ?? 0));
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(28, n));
}

export function normalizeAutoImportHourOfDay(value: unknown): number {
  const n = Math.trunc(Number(value ?? 0));
  if (!Number.isFinite(n)) return 9;
  return Math.max(0, Math.min(23, n));
}

function timeZoneOffsetMs(instant: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = formatter.formatToParts(instant);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    read("hour"),
    read("minute"),
    read("second"),
  );
  return asUtc - instant.getTime();
}

/** 业务时区的「某天某点」→ UTC 时刻（两轮校正，足以覆盖夏令时边界）。 */
function zonedWallClockToUtc(year: number, month: number, day: number, hour: number, timeZone: string): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, 0, 0));
  let result = guess;
  for (let i = 0; i < 2; i += 1) {
    const offset = timeZoneOffsetMs(result, timeZone);
    result = new Date(guess.getTime() - offset);
  }
  return result;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * 下一次执行时刻：严格晚于 `from` 的「每月第 N 天 H 点」。当月已过就顺延到下月，
 * 日期超过当月天数时收到月末（不会因为 31 号在 2 月不存在而永不执行）。
 */
export function computeNextMonthlyRunAt(params: {
  from: Date;
  dayOfMonth: number;
  hourOfDay: number;
  timeZone: string;
}): Date {
  const { from, dayOfMonth, hourOfDay, timeZone } = params;
  const ymd = formatDateInTimeZone(from, timeZone);
  const [year, month] = ymd.split("-").map(Number);
  const target = (y: number, m: number) => {
    const day = Math.min(dayOfMonth, daysInMonth(y, m));
    return zonedWallClockToUtc(y, m, day, hourOfDay, timeZone);
  };
  const candidate = target(year, month);
  if (candidate.getTime() > from.getTime()) return candidate;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return target(nextYear, nextMonth);
}

function buildMailContent(mail: MailDetail): string {
  const attachmentText = (mail.attachments ?? [])
    .filter((attachment) => attachment.text?.trim())
    .map((attachment) => `【附件：${attachment.filename || "未命名 PDF"}】\n${attachment.text!.trim()}`)
    .join("\n\n");
  return [mail.html?.trim() || mail.text?.trim() || "", attachmentText]
    .filter((part) => part && part.trim())
    .join("\n\n");
}

function mailImportedNote(emailAccountId: string, uid: number) {
  return `email:${emailAccountId}:${uid}`;
}

/**
 * 执行一条计划：找下期账单 → 落 pending 任务。
 * 返回是否抓到了新账单。失败时抛错，由调用方记录 lastError。
 */
async function runStatementMailAutoImportSchedule(schedule: {
  id: string;
  householdId: string;
  emailAccountId: string;
  accountId: string | null;
  accountName: string | null;
  fromIncludes: string | null;
  subjectIncludes: string | null;
}): Promise<{ created: boolean; reason?: string }> {
  const account = await prisma.emailAccount.findFirst({
    where: { id: schedule.emailAccountId, householdId: schedule.householdId },
  });
  if (!account) return { created: false, reason: "邮箱账户已删除" };

  const timeZone = await getHouseholdTimeZone(schedule.householdId);
  const now = new Date();
  const sinceDate = formatDateInTimeZone(addDaysUtc(now, -SEARCH_WINDOW_DAYS), timeZone);
  const endDate = formatDateInTimeZone(now, timeZone);

  const trace: string[] = [];
  let client: Awaited<ReturnType<typeof connectAndOpenBox>>["client"] | null = null;
  try {
    const opened = await connectAndOpenBox(
      {
        host: account.imapHost,
        port: account.imapPort,
        secure: account.imapSecure,
        user: account.username,
        password: account.password,
        mailbox: account.mailbox,
      },
      trace,
    );
    client = opened.client;
    const listed = await listMails(client, {
      limit: MAIL_SCAN_LIMIT,
      scanLimit: MAIL_SCAN_LIMIT,
      sinceDate,
      endDate,
      keyword: schedule.subjectIncludes || undefined,
      subjectIncludes: schedule.subjectIncludes || undefined,
      fromIncludes: schedule.fromIncludes || undefined,
    });

    const candidates = listed.items
      .slice()
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.uid - a.uid));

    for (const candidate of candidates) {
      const alreadyJob = await prisma.statementMailAutoImportJob.findFirst({
        where: {
          householdId: schedule.householdId,
          emailAccountId: schedule.emailAccountId,
          uid: candidate.uid,
        },
        select: { id: true },
      });
      if (alreadyJob) continue;
      const alreadyImported = await prisma.importBatch.findFirst({
        where: {
          householdId: schedule.householdId,
          source: "credit_bill_mail",
          note: mailImportedNote(schedule.emailAccountId, candidate.uid),
        },
        select: { id: true },
      });
      if (alreadyImported) continue;

      const detail = await fetchMailDetail(client, candidate.uid);
      const content = buildMailContent(detail);
      if (!content.trim()) continue;

      await prisma.statementMailAutoImportJob.upsert({
        where: {
          householdId_emailAccountId_uid: {
            householdId: schedule.householdId,
            emailAccountId: schedule.emailAccountId,
            uid: candidate.uid,
          },
        },
        create: {
          householdId: schedule.householdId,
          scheduleId: schedule.id,
          emailAccountId: schedule.emailAccountId,
          uid: candidate.uid,
          hash: candidate.hash || null,
          subject: candidate.subject || detail.subject || null,
          fromAddress: candidate.from || detail.from || null,
          mailDate: detail.date ? new Date(detail.date) : null,
          content,
          accountId: schedule.accountId,
          accountName: schedule.accountName,
          status: "pending",
        },
        update: {
          content,
          accountId: schedule.accountId,
          accountName: schedule.accountName,
          status: "pending",
        },
      });
      return { created: true };
    }
    return { created: false, reason: "检索窗口内没有找到新的账单邮件" };
  } finally {
    if (client) await closeImap(client);
  }
}

/**
 * system-task 定时入口：跑所有到期的自动导入计划。
 * 单条计划失败只影响自己 —— 记录 lastError 并把下次时间推后半天再试。
 */
export async function runStatementMailAutoImportTick(): Promise<{ ran: number; created: number; failed: number }> {
  const now = new Date();
  const due = await prisma.statementMailAutoImport.findMany({
    where: { enabled: true, nextRunAt: { lte: now } },
    select: {
      id: true,
      householdId: true,
      emailAccountId: true,
      accountId: true,
      accountName: true,
      fromIncludes: true,
      subjectIncludes: true,
      dayOfMonth: true,
      hourOfDay: true,
    },
    take: 20,
  });

  let created = 0;
  let failed = 0;
  for (const schedule of due) {
    let nextRunAt: Date;
    try {
      const result = await runStatementMailAutoImportSchedule(schedule);
      if (result.created) created += 1;
      const timeZone = await getHouseholdTimeZone(schedule.householdId);
      nextRunAt = computeNextMonthlyRunAt({
        from: new Date(),
        dayOfMonth: schedule.dayOfMonth,
        hourOfDay: schedule.hourOfDay,
        timeZone,
      });
      await prisma.statementMailAutoImport.update({
        where: { id: schedule.id },
        data: {
          lastRunAt: new Date(),
          lastError: result.created ? null : result.reason ?? null,
          nextRunAt,
        },
      });
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`statement mail auto import failed: ${message}`, `system-task schedule=${schedule.id}`);
      await prisma.statementMailAutoImport
        .update({
          where: { id: schedule.id },
          data: {
            lastRunAt: new Date(),
            lastError: message.slice(0, 500),
            nextRunAt: new Date(Date.now() + RETRY_DELAY_MS),
          },
        })
        .catch(() => undefined);
    }
  }
  if (created > 0 || failed > 0) {
    logger.info(`statement mail auto import tick: created ${created}, failed ${failed}`, "system-task");
  }
  return { ran: due.length, created, failed };
}

export type PendingMailAutoImportNotice = {
  id: string;
  title: string;
  accountName: string | null;
  fromAddress: string | null;
  createdAt: string;
};

/** 通知栏用的待导入账单列表（不含正文，正文按需再取）。 */
export async function loadPendingMailAutoImportNotices(
  householdId: string,
  limit = 5,
): Promise<PendingMailAutoImportNotice[]> {
  const rows = await prisma.statementMailAutoImportJob.findMany({
    where: { householdId, status: "pending" },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      subject: true,
      accountName: true,
      fromAddress: true,
      createdAt: true,
    },
  });
  return rows.map((row) => ({
    id: row.id,
    title: row.subject || "邮箱账单",
    accountName: row.accountName ?? null,
    fromAddress: row.fromAddress ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
}
