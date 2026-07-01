"use client";

import { UnifiedEntryLauncher } from "@/components/UnifiedEntryLauncher";

export function TopEntryLauncher({
  defaultAction = "transaction",
}: {
  defaultAction?:
    | "transaction"
    | "transfer"
    | "investment"
    | "wealth"
    | "deposit-buy"
    | "deposit-redeem"
    | "insurance"
    | "debt"
    | "regular-task";
}) {
  return (
    <UnifiedEntryLauncher
      defaultAction={defaultAction}
      actions={[
        { key: "transaction", label: "收支记账" },
        { key: "transfer", label: "转账" },
        { key: "investment", label: "开放式基金 / 货币基金" },
        { key: "wealth", label: "银行理财" },
        { key: "deposit-buy", label: "存款存入" },
        { key: "deposit-redeem", label: "存款取出" },
        { key: "insurance", label: "保险" },
        { key: "debt", label: "借还款" },
        { key: "regular-task", label: "计划任务" },
      ]}
      context={{}}
    />
  );
}
