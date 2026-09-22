import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractAddress } from "@/lib/mail/address";
import { sendFeedbackByRelay } from "@/lib/mail/feedback-relay";
import type { MailAttachment } from "@/lib/mail/types";
import { sendEmailByResend, sendFeedbackEmailByResend } from "@/lib/mail/resend";
import { sendEmail, hasAnySmtpConfig } from "@/lib/mail/smtp";
import { getCurrentUser } from "@/lib/server/auth";

export const runtime = "nodejs";

/** Fixed recipients for user feedback: primary owner + agent mailbox copy. */
const FEEDBACK_TO = ["frankluise5220@gmail.com", "mmh@floatingice.win"];

/** Project feedback keys may only send to the project mailbox. */
const PROJECT_FEEDBACK_TO = "mmh@floatingice.win";

/** Max characters of client logs accepted in one feedback submission. */
const MAX_LOGS_LENGTH = 8000;

/** Image attachments are sent directly with the email and are not persisted. */
const MAX_ATTACHMENT_COUNT = 3;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const ALLOWED_ATTACHMENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

type FeedbackType = "suggestion" | "bug" | "sponsor";

let cachedAppVersion: string | null = null;

/** Reads the app version from package.json (cached after first read). */
function getAppVersion(): string {
  if (cachedAppVersion) return cachedAppVersion;
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8")) as { version?: string };
    cachedAppVersion = pkg.version || "unknown";
  } catch {
    cachedAppVersion = "unknown";
  }
  return cachedAppVersion;
}

function isFeedbackType(value: unknown): value is FeedbackType {
  return value === "suggestion" || value === "bug" || value === "sponsor";
}

/**
 * POST /api/v1/settings/feedback
 *
 * Sends user feedback (suggestions / bug reports / sponsor tip reconciliation)
 * to the product mailbox.
 * Prefers SMTP, falls back to Resend, then the project-owned relay.
 * Bug reports carry a fixed template filled by the user; every submission
 * attaches the app version and recent client-side logs collected by the browser.
 *
 * Body: application/json
 *   { type?: "suggestion" | "bug" | "sponsor", subject: string, content: string, contact?: string, logs?: string }
 * Body: multipart/form-data
 *   type?, subject, content, contact?, logs?, attachments? (up to 3 JPG/PNG/WebP files, 5 MB each)
 * Response: { ok: true } on success, { ok: false, code, error } on failure.
 */
export async function POST(req: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "Authentication is required." }, { status: 401 });
  }

  const contentType = req.headers.get("content-type") ?? "";
  let typeValue: unknown;
  let subjectValue: unknown;
  let contentValue: unknown;
  let contactValue: unknown;
  let logsValue: unknown;
  let attachments: MailAttachment[] = [];

  if (contentType.toLowerCase().includes("multipart/form-data")) {
    const form = await req.formData().catch(() => null);
    if (!form) {
      return NextResponse.json({ ok: false, code: "INVALID_REQUEST", error: "The feedback form could not be read." }, { status: 400 });
    }

    typeValue = form.get("type");
    subjectValue = form.get("subject");
    contentValue = form.get("content");
    contactValue = form.get("contact");
    logsValue = form.get("logs");

    const files = form.getAll("attachments").filter((item): item is File => item instanceof File && item.size > 0);
    if (files.length > MAX_ATTACHMENT_COUNT) {
      return NextResponse.json({ ok: false, code: "TOO_MANY_ATTACHMENTS", error: `Attach at most ${MAX_ATTACHMENT_COUNT} images.` }, { status: 400 });
    }

    for (const file of files) {
      if (!ALLOWED_ATTACHMENT_TYPES.has(file.type)) {
        return NextResponse.json({ ok: false, code: "ATTACHMENT_TYPE_NOT_ALLOWED", error: "Only JPG, PNG, and WebP images can be attached." }, { status: 415 });
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        return NextResponse.json({ ok: false, code: "ATTACHMENT_TOO_LARGE", error: "Each image must be 5 MB or smaller." }, { status: 413 });
      }
    }

    attachments = await Promise.all(files.map(async (file, index) => ({
      filename: safeAttachmentName(file.name, index),
      content: Buffer.from(await file.arrayBuffer()),
      contentType: file.type,
    })));
  } else {
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) {
      return NextResponse.json({ ok: false, code: "INVALID_REQUEST", error: "The feedback request could not be read." }, { status: 400 });
    }
    typeValue = body.type;
    subjectValue = body.subject;
    contentValue = body.content;
    contactValue = body.contact;
    logsValue = body.logs;
  }

  const type: FeedbackType = isFeedbackType(typeValue) ? typeValue : "suggestion";
  const subject = String(subjectValue ?? "").trim();
  const content = String(contentValue ?? "").trim();
  const contact = String(contactValue ?? "").trim();
  const logs = String(logsValue ?? "").trim().slice(0, MAX_LOGS_LENGTH);

  if (!subject) {
    return NextResponse.json({ ok: false, code: "MISSING_SUBJECT", error: "A subject is required." }, { status: 400 });
  }
  if (!content) {
    return NextResponse.json({ ok: false, code: "MISSING_CONTENT", error: "Feedback content is required." }, { status: 400 });
  }

  const typeLabel = type === "bug" ? "Bug" : type === "sponsor" ? "Sponsor tip reconciliation" : "Suggestion";
  const version = getAppVersion();

  const headerLines = [
    `User: ${currentUser.name || "unknown"} (id: ${currentUser.id})`,
    contact ? `Contact: ${contact}` : "",
    `Type: ${typeLabel}`,
    `App version: ${version}`,
  ];
  const logSection = logs ? ["", "---- Client logs ----", logs].join("\n") : "";
  const text = [...headerLines, "", content].filter((line) => line !== "").join("\n") + logSection;

  const html = [
    `<p><strong>User:</strong> ${escapeHtml(currentUser.name || "unknown")} (id: ${escapeHtml(currentUser.id)})</p>`,
    contact ? `<p><strong>Contact:</strong> ${escapeHtml(contact)}</p>` : "",
    `<p><strong>Type:</strong> ${typeLabel}</p>`,
    `<p><strong>App version:</strong> ${escapeHtml(version)}</p>`,
    `<p>${escapeHtml(content).replace(/\n/g, "<br>")}</p>`,
    logs ? `<pre style="white-space:pre-wrap;background:#f5f7fa;padding:8px;border-radius:6px;font-size:12px;">${escapeHtml(logs)}</pre>` : "",
  ].join("");

  const subjectPrefix = type === "bug"
    ? "[MMH Bug]"
    : type === "sponsor"
      ? "[MMH Sponsor Tip]"
      : "[MMH Feedback]";
  const replyTo = extractAddress(contact) ?? undefined;
  const installationId = createHash("sha256")
    .update(`${currentUser.householdId ?? "legacy"}:${currentUser.id}`, "utf8")
    .digest("hex");
  const sendErrors: string[] = [];

  if (await hasAnySmtpConfig(currentUser.householdId)) {
    const smtpResult = await sendEmail({
      to: FEEDBACK_TO.join(", "),
      subject: `${subjectPrefix} ${subject}`,
      text,
      html,
      replyTo,
      attachments: attachments.length > 0 ? attachments : undefined,
      householdId: currentUser.householdId,
    });
    if (smtpResult.ok) return NextResponse.json({ ok: true });
    sendErrors.push(smtpResult.error);
  }

  const result = await sendEmailByResend({
    to: FEEDBACK_TO,
    subject: `${subjectPrefix} ${subject}`,
    text,
    html,
    replyTo,
    attachments: attachments.length > 0 ? attachments : undefined,
  });
  if (result.ok) return NextResponse.json({ ok: true });
  sendErrors.push(result.error);

  const projectResult = await sendFeedbackEmailByResend({
    to: PROJECT_FEEDBACK_TO,
    subject: `${subjectPrefix} ${subject}`,
    text,
    html,
    replyTo,
    attachments: attachments.length > 0 ? attachments : undefined,
  });
  if (projectResult.ok) return NextResponse.json({ ok: true });
  sendErrors.push(projectResult.error);

  const relayResult = await sendFeedbackByRelay({
    subject: `${subjectPrefix} ${subject}`,
    text,
    html,
    replyTo,
    installationId,
    attachments: attachments.length > 0 ? attachments : undefined,
  });
  if (relayResult.ok) return NextResponse.json({ ok: true });

  return NextResponse.json(
    {
      ok: false,
      code: relayResult.code,
      error: relayResult.error || sendErrors.join("; "),
      retryAfterSeconds: relayResult.retryAfterSeconds,
    },
    { status: relayResult.status },
  );
}

function safeAttachmentName(name: string, index: number) {
  const cleaned = name.trim().replace(/[\r\n]/g, "").replace(/[\\/]/g, "_").slice(0, 180);
  return cleaned || `feedback-image-${index + 1}`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
