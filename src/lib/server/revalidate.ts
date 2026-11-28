import { revalidatePath, revalidateTag } from "next/cache";

import { invalidateInvestmentReportCache } from "@/lib/server/investment-report-cache";

type RevalidateOptions = {
  /**
   * true = 不 purge 首页路由 "/"。
   *
   * purge 当前所在路由会让 server action 的响应带上当前页面的新 RSC payload，
   * Next 会整棵重渲染首页（用户看到的就是「保存后全页面刷新」：卡 1~2 秒、
   * 滚动位置和表格状态一起丢）。编辑 / 普通收支新增保存传 true：首页自己会补上 UI ——
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
  revalidateTag("category-usage", "max");
  // 投资收益报表结果缓存在进程内（概览/报表/每日盈亏共用），写流水后必须清掉，
  // 否则「记完一笔回概览」看到的是旧数字。
  invalidateInvestmentReportCache();
  if (!options?.skipHomePath) revalidatePath("/");
  revalidatePath("/overview");
  revalidatePath("/accounts");
}

export function revalidateAfterEntryOrderChange() {
  revalidateTag("entries", "max");
}

export function revalidateAfterInvestChange(options?: RevalidateOptions) {
  revalidateAfterTxChange(options);
  // 持仓必须 read-your-own-writes：投资账户的持仓 / 份额来自
  // `loadInvestBalances`（unstable_cache，revalidate: false），命中缓存时
  // `revalidateTag(tag, "max")` 是 stale-while-revalidate —— 写操作之后客户端
  // 立刻 refetch 会先拿回写之前的快照（「删了几笔基金买入，赎回份额还是旧的」）。
  // 持仓相关 tag 立即过期，不要改回 "max"。
  expireTagNow("invest-balances");
  expireTagNow("fund-holding");
  revalidateTag("invest-account-data", "max");
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
 * Stock transaction writes (`/api/v1/stocks/transactions*`, `/api/v1/stocks/import`)
 * must be read-your-own-writes: the stock view refetches its transaction list and
 * holdings right after the save, and that refetch is the only thing that puts the
 * new row on screen. `revalidateTag(tag, "max")` in `revalidateAfterInvestChange`
 * is stale-while-revalidate, so a plain `revalidateAfterInvestChange()` from a
 * Route Handler hands the pre-write snapshot back to that refetch and the row the
 * user just saved never renders ("刚记的两笔在页面上不显示，数据表里有").
 * Expire the two stock list caches immediately instead.
 */
export function revalidateAfterStockTransactionChange(options?: RevalidateOptions) {
  revalidateAfterInvestChange(options);
  expireTagNow("stock-transactions");
  expireTagNow("stock-holding-report");
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
  // 同上：基金持仓 / 份额是 read-your-own-writes 的，必须立即过期。
  expireTagNow("invest-balances");
  expireTagNow("fund-holding");
  revalidateTag("invest-account-data", "max");
}

/**
 * Settings writes (account create/update/delete, institutions, categories, ...)
 * are read-your-own-writes: `revalidateTag(tag, "max")` is
 * stale-while-revalidate, so the next request still gets the pre-write
 * `common-data` snapshot (which holds the account list) and only the request
 * after that sees the new value — users perceive it as "I edited the account
 * but the cache still shows the old data". `updateTag` only works inside Server
 * Actions; Route Handlers must use `revalidateTag(tag, { expire: 0 })` to expire
 * the tag immediately (see node_modules/next/dist/docs/.../revalidateTag.md).
 */
function expireTagNow(tag: string) {
  revalidateTag(tag, { expire: 0 });
}

export function revalidateAfterSettingsChange() {
  expireTagNow("common-data");
  expireTagNow("invest-balances");
  expireTagNow("category-usage");
  revalidatePath("/");
  revalidatePath("/accounts");
  revalidatePath("/settings/accounts");
  revalidatePath("/settings/institutions");
  revalidatePath("/settings/counterparties");
  revalidatePath("/settings/family-members");
  revalidatePath("/settings/categories");
  revalidatePath("/settings/tags");
}
