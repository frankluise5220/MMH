import { revalidatePath, revalidateTag } from "next/cache";

export function revalidateAfterTxChange() {
  revalidateTag("common-data", "max");
  revalidateTag("entries", "max");
  revalidatePath("/");
  revalidatePath("/overview");
  revalidatePath("/accounts");
}

export function revalidateAfterEntryOrderChange() {
  revalidateTag("entries", "max");
}

export function revalidateAfterInvestChange() {
  revalidateAfterTxChange();
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
