import { revalidatePath } from "next/cache";

/** 交易记录变更后刷新所有相关页面（含 Sidebar） */
export function revalidateAfterTxChange() {
  revalidatePath("/");
  revalidatePath("/overview");
  revalidatePath("/accounts");
}

/** 投资相关变更后刷新（含交易页面 + Sidebar） */
export function revalidateAfterInvestChange() {
  revalidateAfterTxChange();
  revalidatePath("/invest");
  revalidatePath("/funds");
  revalidatePath("/regular-invest");
}

/** 设置页变更后刷新（含 Sidebar） */
export function revalidateAfterSettingsChange() {
  revalidatePath("/");
  revalidatePath("/accounts");
  revalidatePath("/settings/accounts");
  revalidatePath("/settings/institutions");
  revalidatePath("/settings/categories");
}