"use client";

import { useCallback, useEffect, useState } from "react";

import {
  StatementImportPreviewDialog,
  type StatementImportPreviewItem,
} from "@/components/StatementImportPreviewDialog";
import { showChoiceDialog } from "@/lib/client/confirm-dialog";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { useI18n } from "@/lib/i18n";

/**
 * 邮箱账单「下期自动导入」的接收端。
 *
 * 服务端定时把下一期账单抓成 StatementMailAutoImportJob（只有原文，不落账），
 * 通知栏点「打开导入」时派发事件到这里：取回原文 → 走同一个 /statement/parse →
 * 打开导入预览。用户确认后才 POST /statement/import，此时行为与手动点「导入账单」
 * 完全一致（同一条 API、同一套账户匹配）。
 *
 * 之所以放在全局（sidebar layout）而不是设置页：通知栏在每一页都能点。
 */

export const MAIL_AUTO_IMPORT_OPEN_EVENT = "mmh:statement:mail-auto-import";

type MailAutoImportJob = {
  id: string;
  subject: string | null;
  fromAddress: string | null;
  mailDate: string | null;
  content: string;
  accountId: string | null;
  accountName: string | null;
  emailAccountId: string;
  uid: number;
  hash: string | null;
  status: string;
};

export function StatementMailAutoImportHost() {
  const { t } = useI18n();
  const [job, setJob] = useState<MailAutoImportJob | null>(null);
  const [items, setItems] = useState<StatementImportPreviewItem[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const openJob = useCallback(async (jobId: string) => {
    setOpen(true);
    setLoading(true);
    setError("");
    setItems([]);
    setJob(null);
    try {
      const jobRes = await fetch(`/api/v1/statement/mail-auto-import/jobs/${jobId}`, { cache: "no-store" });
      const jobData = await jobRes.json().catch(() => null);
      if (!jobData?.ok || !jobData.data) throw new Error(jobData?.error || "job");
      const payload = jobData.data as MailAutoImportJob;
      setJob(payload);

      const parseRes = await fetch("/api/v1/statement/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: payload.content }),
      });
      const parsed = await parseRes.json().catch(() => null);
      if (!parsed?.ok) throw new Error(parsed?.error || "parse");
      setItems(Array.isArray(parsed.items) ? (parsed.items as StatementImportPreviewItem[]) : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setOpen(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ jobId?: string }>).detail;
      if (detail?.jobId) void openJob(detail.jobId);
    };
    window.addEventListener(MAIL_AUTO_IMPORT_OPEN_EVENT, handler);
    return () => window.removeEventListener(MAIL_AUTO_IMPORT_OPEN_EVENT, handler);
  }, [openJob]);

  const markJob = useCallback(async (jobId: string, status: "imported" | "dismissed") => {
    await fetch(`/api/v1/statement/mail-auto-import/jobs/${jobId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    }).catch(() => undefined);
  }, []);

  const confirm = useCallback(
    async (confirmed: StatementImportPreviewItem[]) => {
      if (!job || !confirmed.length) return;
      setBusy(true);
      setError("");
      const mailSource = {
        emailAccountId: job.emailAccountId,
        uid: job.uid,
        hash: job.hash || undefined,
        subject: job.subject ?? "",
        from: job.fromAddress ?? "",
        date: job.mailDate ? String(job.mailDate).slice(0, 10) : "",
      };
      try {
        let policy: "overwrite" | "keep" | undefined;
        for (;;) {
          const res = await fetch("/api/v1/statement/import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              items: confirmed,
              autoCreateAccounts: false,
              mailSource,
              manualRecordConflictPolicy: policy,
            }),
          });
          const data = await res.json().catch(() => null);
          if (data?.ok) {
            await markJob(job.id, "imported");
            dispatchFinanceDataChanged();
            setOpen(false);
            setJob(null);
            setItems([]);
            return;
          }
          if (data?.code !== "MANUAL_RECORD_CONFLICT") {
            setError(data?.error || t("statement.mailAutoImport.importFailed"));
            return;
          }
          setBusy(false);
          const conflictCount = Number(data.conflict?.total ?? 0);
          const choice = await showChoiceDialog<"overwrite" | "keep">({
            title: t("settings.email.manualConflictTitle"),
            message: t("settings.email.manualConflictMessage", { count: conflictCount }),
            choices: [
              { value: "keep", label: t("settings.email.manualConflictKeep") },
              { value: "overwrite", label: t("settings.email.manualConflictOverwrite"), tone: "danger" },
            ],
            cancelLabel: t("common.cancel"),
          });
          if (!choice) return;
          policy = choice;
          setBusy(true);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [job, markJob, t],
  );

  if (!open) return null;

  return (
    <>
      <StatementImportPreviewDialog
        open={open}
        title={t("statement.mailAutoImport.title")}
        description={
          loading
            ? t("statement.mailAutoImport.loading")
            : [job?.subject, job?.fromAddress].filter(Boolean).join(" · ")
        }
        items={items}
        defaultAccountName={job?.accountName ?? ""}
        sourceAccountId={job?.accountId ?? null}
        busy={busy}
        onClose={() => {
          if (busy) return;
          // 关闭只是关窗口，任务仍留在通知栏，下次还能从通知进来。
          setOpen(false);
        }}
        onConfirm={(confirmed) => void confirm(confirmed)}
      />
      {error ? (
        <div className="fixed bottom-4 left-1/2 z-[1300] -translate-x-1/2 rounded-lg bg-rose-600 px-3 py-2 text-xs text-white shadow-lg">
          {error}
        </div>
      ) : null}
    </>
  );
}
