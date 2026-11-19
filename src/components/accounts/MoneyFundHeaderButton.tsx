"use client";

/**
 * 电子钱包视图表头的「货币基金」入口（2026-11-19 用户裁定）。
 *
 * 用户口径：货基设定属于「这只钱包」的事，入口就放在电子钱包视图的表头，
 * 而不是设置 → 账户的表格工具栏；弹窗进来的对象就是当前这只钱包，不再选账户。
 *
 * 弹窗本体是 MoneyFundIncomeDialog，这里只负责开关状态与「改完之后让这个视图重新取数」。
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Coins } from "lucide-react";
import {
  MoneyFundIncomeDialog,
  prefetchMoneyFundSegments,
  type MoneyFundWalletAccount,
} from "@/components/accounts/MoneyFundIncomeDialog";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { useI18n } from "@/lib/i18n";

type Props = {
  /** 当前视图正在看的这只钱包（弹窗唯一对象，不提供下拉切换）。 */
  account: MoneyFundWalletAccount;
};

export function MoneyFundHeaderButton({ account }: Props) {
  const { t } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        // 指针移上来 / 键盘聚焦就先拉一次绑定历史：点开直接有内容，不用先看 loading。
        onPointerEnter={() => void prefetchMoneyFundSegments(account.id)}
        onFocus={() => void prefetchMoneyFundSegments(account.id)}
        title={t("settings.accounts.moneyFund.title")}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-xs text-slate-600 shadow-sm transition-colors hover:bg-slate-50"
      >
        <Coins className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
        <span className="hidden sm:inline">{t("settings.accounts.moneyFund.button")}</span>
      </button>
      <MoneyFundIncomeDialog
        open={open}
        account={account}
        onClose={() => setOpen(false)}
        onChanged={(reason) => {
          // 收益行落在钱包账户上：明细列表、余额、汇总都要跟着重取。
          dispatchFinanceDataChanged({ reason, accountIds: [account.id] });
          router.refresh();
        }}
      />
    </>
  );
}
