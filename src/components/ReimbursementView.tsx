"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import { ReimbursementWorkspace, type ReimbursementActions, type ReimbursementCashAccountOption } from "@/components/ReimbursementModal";
import type { ReimbursementFormEntry, ReimbursementObjectOption } from "@/components/ReimbursementFormModal";

export function ReimbursementView({
  objectId,
  objectName,
  accountName,
  advanceAccountId,
  cashAccountOptions,
  objectOptions,
  initialShowCreate,
  actions,
}: {
  objectId: string;
  objectName: string;
  accountName: string;
  advanceAccountId: string;
  cashAccountOptions: ReimbursementCashAccountOption[];
  objectOptions?: ReimbursementObjectOption[];
  initialShowCreate: boolean;
  actions: ReimbursementActions;
}) {
  const searchParams = useSearchParams();
  const { t } = useI18n();
  const [entries, setEntries] = useState<ReimbursementFormEntry[]>([]);
  const [seedStateReady, setSeedStateReady] = useState(false);

  useEffect(() => {
    const rawEntries = window.sessionStorage.getItem("mmh:reimbursement:createEntries");
    if (rawEntries) {
      window.sessionStorage.removeItem("mmh:reimbursement:createEntries");
      try {
        const parsed: unknown = JSON.parse(rawEntries);
        if (Array.isArray(parsed)) setEntries(parsed as ReimbursementFormEntry[]);
      } catch (error) {
        console.error("Failed to restore reimbursement entries", error);
      }
    }
    setSeedStateReady(true);
  }, []);
  const createRequested = searchParams.get("create") === "1";

  if (!seedStateReady) {
    return <div className="min-h-0 flex-1 animate-pulse bg-background" aria-label={t("liabilityShell.saving")} />;
  }

  return (
    <ReimbursementWorkspace
      objectId={objectId}
      objectType="counterparty"
      objectName={objectName}
      accountName={accountName}
      advanceAccountId={advanceAccountId}
      cashAccountOptions={cashAccountOptions}
      objectOptions={objectOptions}
      actions={actions}
      initialShowCreate={initialShowCreate || createRequested}
      initialCreateEntries={entries}
    />
  );
}
