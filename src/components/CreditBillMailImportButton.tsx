"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { createPortal } from "react-dom";
import { MailSearch, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";

const EmailSettingsPage = dynamic(
  () => import("@/app/(sidebar)/settings/email/page"),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-sm text-slate-400">
        正在打开邮箱账单导入...
      </div>
    ),
  },
);

type CreditBillMailImportButtonProps = {
  accountId?: string;
  accountName: string;
};

export function CreditBillMailImportButton(props: CreditBillMailImportButtonProps) {
  void props;

  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 hover:bg-blue-50 hover:text-blue-700"
        title={t("creditBill.fetchMailTitle")}
      >
        <MailSearch className="h-3.5 w-3.5" />
        {t("creditBill.fetch")}
      </button>

      {open && typeof document !== "undefined" ? createPortal(
        <div className="fixed inset-0 z-[90] flex items-start justify-center bg-slate-900/30 px-4 py-[4vh]">
          <div className="flex h-[90vh] min-h-[560px] w-full max-w-7xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-slate-50 shadow-2xl">
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-slate-800">{t("creditBill.fetchMailTitle")}</div>
                <div className="mt-0.5 truncate text-xs text-slate-500">
                  使用系统设置里的同一套邮箱账单读取、HTML 预览、识别和导入流程。
                </div>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                title={t("creditBill.close")}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
              <EmailSettingsPage />
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
