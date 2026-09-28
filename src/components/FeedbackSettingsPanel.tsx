"use client";

import { useEffect, useRef, useState } from "react";
import { Paperclip, Send, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { buildFeedbackLogsPayload } from "@/lib/client/feedback-logs";

type FeedbackType = "suggestion" | "bug" | "sponsor";
type Translate = (key: string, params?: Record<string, string | number>) => string;

const MAX_ATTACHMENT_COUNT = 3;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const ALLOWED_ATTACHMENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function formatSponsorTime(date: Date, t: Translate) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const hour12 = hours % 12 || 12;
  const minute = String(date.getMinutes()).padStart(2, "0");
  const monthName = new Intl.DateTimeFormat("en-US", { month: "long" }).format(date);
  const ampm = hours < 12 ? "AM" : "PM";

  return t("settings.feedback.sponsorTimeFormat", {
    year,
    month,
    monthName,
    day,
    hour: hours,
    hour12,
    minute,
    ampm,
  });
}

function getFeedbackPreset(type: FeedbackType, t: Translate, date = new Date()) {
  if (type === "bug") {
    return { subject: "", content: t("settings.feedback.bugTemplate") };
  }
  if (type === "sponsor") {
    const time = formatSponsorTime(date, t);
    return {
      subject: t("settings.feedback.sponsorSubject"),
      content: t("settings.feedback.sponsorTemplate", { time }),
    };
  }
  return { subject: "", content: "" };
}

export function FeedbackSettingsPanel() {
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const initializedFromQuery = useRef(false);
  const [feedbackType, setFeedbackType] = useState<FeedbackType>("suggestion");
  const [subject, setSubject] = useState("");
  const [content, setContent] = useState("");
  const [subjectTouched, setSubjectTouched] = useState(false);
  const [contentTouched, setContentTouched] = useState(false);
  const [contact, setContact] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  useEffect(() => {
    if (initializedFromQuery.current) return;
    initializedFromQuery.current = true;

    const params = new URLSearchParams(window.location.search);
    if (params.get("type") !== "sponsor") return;

    const timestamp = Number(params.get("time"));
    const date = Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp) : new Date();
    const preset = getFeedbackPreset("sponsor", t, date);
    setFeedbackType("sponsor");
    setSubject(preset.subject);
    setContent(preset.content);
  }, [t]);

  function switchType(next: FeedbackType) {
    if (next === feedbackType) return;
    const preset = getFeedbackPreset(next, t);
    setFeedbackType(next);
    if (!subjectTouched) setSubject(preset.subject);
    if (!contentTouched) setContent(preset.content);
    setError("");
  }

  function addAttachments(fileList: FileList | null) {
    const files = Array.from(fileList ?? []);
    if (files.length === 0) return;

    const next = [...attachments];
    for (const file of files) {
      if (next.length >= MAX_ATTACHMENT_COUNT) {
        setError(t("settings.feedback.attachmentsTooMany", { count: MAX_ATTACHMENT_COUNT }));
        break;
      }
      if (!ALLOWED_ATTACHMENT_TYPES.has(file.type)) {
        setError(t("settings.feedback.attachmentTypeInvalid", { name: file.name }));
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setError(t("settings.feedback.attachmentTooLarge", { name: file.name }));
        continue;
      }
      const duplicate = next.some((item) => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified);
      if (!duplicate) next.push(file);
    }

    setAttachments(next);
    setInfo("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeAttachment(index: number) {
    setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index));
    setError("");
  }

  async function submit() {
    const trimmedSubject = subject.trim();
    const trimmedContent = content.trim();
    if (!trimmedSubject) {
      setError(t("settings.feedback.subjectRequired"));
      return;
    }
    if (!trimmedContent) {
      setError(t("settings.feedback.contentRequired"));
      return;
    }
    setSending(true);
    setError("");
    setInfo("");
    try {
      const form = new FormData();
      form.set("type", feedbackType);
      form.set("subject", trimmedSubject);
      form.set("content", trimmedContent);
      form.set("contact", contact.trim());
      form.set("logs", buildFeedbackLogsPayload());
      for (const file of attachments) form.append("attachments", file, file.name);

      const res = await fetch("/api/v1/settings/feedback", {
        method: "POST",
        body: form,
      });
      const data = await res.json().catch(() => null) as {
        ok?: boolean;
        code?: string;
        retryAfterSeconds?: number;
      } | null;
      if (res.ok && data?.ok) {
        setInfo(t("settings.feedback.sent"));
        setSubject("");
        setContent("");
        setSubjectTouched(false);
        setContentTouched(false);
        setContact("");
        setAttachments([]);
      } else {
        const minutes = Math.max(1, Math.ceil((data?.retryAfterSeconds ?? 1800) / 60));
        setError(t(feedbackErrorKey(data?.code), { count: MAX_ATTACHMENT_COUNT, minutes }));
      }
    } catch {
      setError(t("settings.feedback.sendFailed"));
    } finally {
      setSending(false);
    }
  }

  const typeOptions: Array<{ value: FeedbackType; label: string }> = [
    { value: "suggestion", label: t("settings.feedback.typeSuggestion") },
    { value: "bug", label: t("settings.feedback.typeBug") },
    { value: "sponsor", label: t("settings.feedback.typeSponsor") },
  ];

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white px-4 py-4">
        <h2 className="text-sm font-semibold text-slate-800">{t("settings.feedback.title")}</h2>
        <p className="mt-1 text-xs text-slate-500">{t("settings.feedback.description")}</p>
        <p className="mt-1 text-xs text-slate-400">{t("settings.feedback.attachNotice")}</p>
      </div>

      {error && <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}
      {info && <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700">{info}</div>}

      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="block text-xs font-medium text-slate-600">{t("settings.feedback.typeLabel")}</label>
            <div className="inline-flex rounded-md border border-slate-200 p-0.5">
              {typeOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => switchType(option.value)}
                  className={
                    feedbackType === option.value
                      ? "rounded-[5px] bg-blue-600 px-3 py-1.5 text-xs font-medium text-white"
                      : "rounded-[5px] px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:text-slate-900"
                  }
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1">
            <label className="block text-xs font-medium text-slate-600">{t("settings.feedback.subjectLabel")}</label>
            <input
              value={subject}
              onChange={(e) => {
                setSubject(e.target.value);
                setSubjectTouched(true);
              }}
              placeholder={t("settings.feedback.subjectPlaceholder")}
              className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-300"
            />
          </div>

          <div className="space-y-1">
            <label className="block text-xs font-medium text-slate-600">{t("settings.feedback.contentLabel")}</label>
            <textarea
              value={content}
              onChange={(e) => {
                setContent(e.target.value);
                setContentTouched(true);
              }}
              placeholder={
                feedbackType === "bug"
                  ? t("settings.feedback.bugContentPlaceholder")
                  : feedbackType === "sponsor"
                    ? t("settings.feedback.sponsorContentPlaceholder")
                    : t("settings.feedback.contentPlaceholder")
              }
              rows={feedbackType === "bug" ? 9 : 6}
              className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-300"
            />
          </div>

          <div className="space-y-1">
            <label className="block text-xs font-medium text-slate-600">{t("settings.feedback.contactLabel")}</label>
            <input
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              placeholder={t("settings.feedback.contactPlaceholder")}
              className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-300"
            />
          </div>

          <div className="space-y-1">
            <label className="block text-xs font-medium text-slate-600">{t("settings.feedback.attachmentsLabel")}</label>
            <div className="rounded-md border border-slate-200 bg-slate-50/60 p-2.5">
              {attachments.length > 0 ? (
                <div className="mb-2 space-y-1">
                  {attachments.map((file, index) => (
                    <div key={`${file.name}-${file.lastModified}`} className="flex items-center gap-2 rounded border border-slate-200 bg-white px-2 py-1.5">
                      <Paperclip className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                      <span className="min-w-0 flex-1 truncate text-xs text-slate-600">{file.name}</span>
                      <button
                        type="button"
                        onClick={() => removeAttachment(index)}
                        title={t("settings.feedback.removeAttachment")}
                        aria-label={t("settings.feedback.removeAttachment")}
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={attachments.length >= MAX_ATTACHMENT_COUNT}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs text-slate-600 transition-colors hover:border-blue-200 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Paperclip className="h-3.5 w-3.5" />
                  {t("settings.feedback.addAttachment")}
                </button>
                <span className="text-[11px] text-slate-400">{t("settings.feedback.attachmentsHint", { count: MAX_ATTACHMENT_COUNT })}</span>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
                multiple
                className="sr-only"
                onChange={(event) => addAttachments(event.target.files)}
              />
            </div>
          </div>

          <div className="flex justify-end pt-1">
            <button
              type="button"
              onClick={submit}
              disabled={sending}
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-blue-600 px-4 text-sm text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              <Send className="h-3.5 w-3.5" />
              {sending ? t("settings.feedback.sending") : t("settings.feedback.submit")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function feedbackErrorKey(code: string | undefined) {
  switch (code) {
    case "MISSING_SUBJECT":
      return "settings.feedback.subjectRequired";
    case "MISSING_CONTENT":
      return "settings.feedback.contentRequired";
    case "TOO_MANY_ATTACHMENTS":
      return "settings.feedback.attachmentsTooMany";
    case "ATTACHMENT_TYPE_NOT_ALLOWED":
      return "settings.feedback.attachmentTypeInvalid";
    case "ATTACHMENT_TOO_LARGE":
      return "settings.feedback.attachmentTooLarge";
    case "RATE_LIMITED":
      return "settings.feedback.rateLimited";
    default:
      return "settings.feedback.sendFailed";
  }
}
