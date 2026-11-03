"use client";

import { UnifiedEntryLauncher } from "@/components/UnifiedEntryLauncher";
import { useI18n } from "@/lib/i18n";

/**
 * ⚠️ 这不是用户说的「胶囊菜单」。用户口径的「胶囊菜单」= 视图右上角的快捷记账入口，
 * 在首页 RSC（src/app/(sidebar)/page.tsx，header 内的 UnifiedEntryLauncher，内联 actions）。
 * 改「银行理财 ▸ 投顾组合」这类菜单结构时优先改 page.tsx 那份；本组件仅供顶部导航等
 * 其他位置复用，两边菜单需保持同构。
 */
export function TopEntryLauncher({
  defaultAction = "transaction",
}: {
  defaultAction?:
    | "transaction"
    | "transfer"
    | "fx"
    | "fx-sell"
    | "investment"
    | "stock"
    | "stock-transfer"
    | "wealth"
    | "bond"
    | "deposit-buy"
    | "deposit-redeem"
    | "insurance"
    | "settlement"
    | "regular-task";
}) {
  const { t } = useI18n();
  return (
    <UnifiedEntryLauncher
      defaultAction={defaultAction}
      actions={[
        { key: "transaction", label: t("basicDetail.guide.entry.title") },
        { key: "transfer", label: t("transaction.type.transfer") },
        {
          key: "fx",
          label: t("entry.kind.fxGroup"),
          children: [
            { key: "fx", label: t("entry.kind.fx") },
            { key: "fx-sell", label: t("entry.kind.fxSell") },
          ],
        },
        { key: "investment", label: t("txForm.fund") },
        { key: "stock", label: t("investment.product.stock") },
        { key: "stock-transfer", label: t("stockPanel.transfer") },
        { key: "wealth", label: t("investment.product.wealth") },
        {
          key: "bond",
          label: t("entry.kind.bond"),
          children: [
            { key: "bond", label: t("bondForm.title.create") },
            { key: "bond-repo-lend", label: t("entry.kind.bondRepoLend") },
            { key: "bond-repo-redeem", label: t("entry.kind.bondRepoRedeem") },
          ],
        },
        { key: "deposit-buy", label: t("txForm.depositIn") },
        { key: "deposit-redeem", label: t("detailView.depositWithdraw") },
        { key: "insurance", label: t("sidebar.section.insurance") },
        { key: "settlement", label: t("liabilityTx.borrowRepay") },
        { key: "regular-task", label: t("nav.scheduledTasks") },
      ]}
      context={{}}
    />
  );
}
