import { revalidatePath, revalidateTag } from "next/cache";

export type RevalidateOptions = {
  /**
   * true = 不 purge 首页路由 "/"。
   *
   * purge 当前所在路由会让 server action 的响应带上当前页面的新 RSC payload，
   * Next 会整棵重渲染首页（用户看到的就是「保存后全页面刷新」：卡 1~2 秒、
   * 滚动位置和表格状态一起丢）。编辑类保存传 true：首页自己会补上 UI ——
   * DetailViewClient 按当前页重取明细、LiveAccountBalance / SidebarClient
   * 打补丁刷新余额。
   *
   * Tag 仍然会失效 unstable_cache，所以下一次导航（包括导航回 "/")一定会
   * 渲染到最新数据，不会留下脏数据。
   */
  skipHomePath?: boolean;
};

export function revalidateAfterTxChange(options?: RevalidateOptions) {
  revalidateTag("common-data", "max");
  revalidateTag("entries", "max");
  if (!options?.skipHomePath) revalidatePath("/");
  revalidatePath("/overview");
  revalidatePath("/accounts");
}

export function revalidateAfterEntryOrderChange() {
  revalidateTag("entries", "max");
}

export function revalidateAfterInvestChange(options?: RevalidateOptions) {
  revalidateAfterTxChange(options);
  revalidateTag("invest-balances", "max");
  revalidateTag("invest-account-data", "max");
  revalidateTag("fund-holding", "max");
  revalidateTag("stock-holding-report", "max");
  revalidateTag("stock-transactions", "max");
  revalidateTag("fixed-asset-display", "max");
  revalidateTag("fixed-asset-transactions", "max");
  revalidatePath("/invest");
  revalidatePath("/investments");
  revalidatePath("/funds");
  revalidatePath("/regular-invest");
  revalidatePath("/reports");
}

/**
 * Fund-shell saves (fund / money / metal / wealth) refresh ONLY via tags —
 * no revalidatePath, so the server action response does not carry a fresh RSC
 * payload for the current page (the 1-2.5s full re-render per save).
 *
 * The client covers the immediate UI instead: FundShell refetches shell-data,
 * sidebar/header patch the scoped accounts, DetailViewClient refetches detail
 * rows. Tags still invalidate `unstable_cache` so the NEXT navigation (and any
 * other route) renders with fresh data.
 */
export function revalidateAfterFundShellChange() {
  revalidateTag("common-data", "max");
  revalidateTag("entries", "max");
  revalidateTag("invest-balances", "max");
  revalidateTag("invest-account-data", "max");
  revalidateTag("fund-holding", "max");
}

export function revalidateAfterSettingsChange() {
  revalidateTag("common-data", "max");
  revalidateTag("invest-balances", "max");
  revalidatePath("/");
  revalidatePath("/accounts");
  revalidatePath("/settings/accounts");
  revalidatePath("/settings/institutions");
  revalidatePath("/settings/counterparties");
  revalidatePath("/settings/family-members");
  revalidatePath("/settings/categories");
  revalidatePath("/settings/tags");
}
