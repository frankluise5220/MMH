import { revalidatePath, revalidateTag } from "next/cache";

/** 交易记录变更后刷新所有相关页面（含 Sidebar + 缓存层） */
export function revalidateAfterTxChange() {
  revalidateTag("common-data", "page");
  revalidateTag("entries", "page");
  revalidatePath("/", "page");
  revalidatePath("/overview", "page");
  revalidatePath("/accounts", "page");
}

/** 投资相关变更后刷新（含交易页面 + Sidebar + 持仓缓存） */
export function revalidateAfterInvestChange() {
  revalidateAfterTxChange();
  revalidateTag("invest-account-data", "page");
  revalidateTag("fund-holding", "page");
  revalidatePath("/invest", "page");
  revalidatePath("/funds", "page");
  revalidatePath("/regular-invest", "page");
}

/** 设置页变更后刷新（含 Sidebar + 缓存层） */
export function revalidateAfterSettingsChange() {
  revalidateTag("common-data", "page");
  revalidatePath("/", "page");
  revalidatePath("/accounts", "page");
  revalidatePath("/settings/accounts", "page");
  revalidatePath("/settings/institutions", "page");
  revalidatePath("/settings/categories", "page");
}