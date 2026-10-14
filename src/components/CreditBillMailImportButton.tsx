"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { MailSearch, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { warmEmailSettings } from "@/lib/client/settingsCache";

const EmailSettingsPanel = dynamic(
  () => import("@/components/EmailSettingsPanel").then((mod) => mod.EmailSettingsPanel),
  {
    ssr: false,
    loading: () => <EmailSettingsLoading />,
  },
);

/**
 * Warms both halves of what the dialog waits for: the panel chunk (this module
 * is big — importing it inline is what makes the first open feel slow) and the
 * mail settings data. Safe to call repeatedly.
 */
export function prefetchMailImportPanel() {
  if (typeof window === "undefined") return;
  void import("@/components/EmailSettingsPanel").catch(() => null);
  warmEmailSettings();
}

function EmailSettingsLoading() {
  const { t } = useI18n();
  return (
    <div className="flex h-full items-center justify-center text-sm text-slate-400">
      {t("creditBill.mailImportLoading")}
    </div>
  );
}

type CreditBillMailImportButtonProps = {
  accountId?: string;
  accountName: string;
};

type CreditBillMailImportDialogProps = {
  open: boolean;
  onClose: () => void;
  accountId?: string;
  accountName?: string;
};

export function CreditBillMailImportDialog({ open, onClose, accountId, accountName }: CreditBillMailImportDialogProps) {
  void accountId;
  void accountName;
  const { t } = useI18n();
  const [previewOpen, setPreviewOpen] = useState(false);

  // 关闭时必须复位 previewOpen。本组件关闭时只是 return null、并不会卸载，
  // 于是 previewOpen 会跨「关闭 → 重开」残留；而 previewOpen=true 会让外层遮罩渲染成
  // `opacity-0 + pointer-events-none`（见下方 mailOverlayHidden）——重开时整层都是透明且
  // 不可点的，用户看到的现象就是「邮箱导入关掉之后再也点不开」。
  useEffect(() => {
    if (!open) setPreviewOpen(false);
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  // When the statement preview opens, hide the mail dialog visually but keep
  // the tree mounted so the preview dialog (a child of EmailSettingsPanel)
  // stays alive. Fully close only after the preview is dismissed.
  const mailOverlayHidden = previewOpen;

  return createPortal(
    <div className={`fixed inset-0 z-[90] flex items-center justify-center bg-slate-900/30 px-4 py-4${mailOverlayHidden ? " pointer-events-none opacity-0" : ""}`}>
      <div className="flex max-h-[90vh] w-full max-w-7xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-slate-50 shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-800">{t("creditBill.fetchMailTitle")}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            title={t("creditBill.close")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
          <EmailSettingsPanel
            embedded
            onStatementPreviewOpened={() => setPreviewOpen(true)}
            onStatementPreviewClosed={() => {
              // 预览关掉后要把外层恢复成可见可点（否则父级若保持 open=true，这里会一直是透明遮罩）。
              setPreviewOpen(false);
              onClose();
            }}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function CreditBillMailImportButton(props: CreditBillMailImportButtonProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  // Touch devices never fire hover, so also warm the chunk once the browser is
  // idle. Without this the first open pays for downloading the panel.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number })
      .requestIdleCallback;
    if (typeof idle === "function") {
      const handle = idle(() => prefetchMailImportPanel(), { timeout: 4000 });
      return () => {
        (window as unknown as { cancelIdleCallback?: (handle: number) => void }).cancelIdleCallback?.(handle);
      };
    }
    const timer = window.setTimeout(prefetchMailImportPanel, 2000);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <>
      <button
        type="button"
        onMouseEnter={() => prefetchMailImportPanel()}
        onFocus={() => prefetchMailImportPanel()}
        onPointerDown={() => prefetchMailImportPanel()}
        onClick={() => {
          prefetchMailImportPanel();
          setOpen(true);
        }}
        className="inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 hover:bg-blue-50 hover:text-blue-700"
        title={t("creditBill.fetchMailTitle")}
      >
        <MailSearch className="h-3.5 w-3.5" />
        {t("creditBill.fetchMailTitle")}
      </button>

      <CreditBillMailImportDialog
        open={open}
        onClose={() => setOpen(false)}
        accountId={props.accountId}
        accountName={props.accountName}
      />
    </>
  );
}
