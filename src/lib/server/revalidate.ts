import { revalidatePath, revalidateTag } from "next/cache";

export function revalidateAfterTxChange() {
  revalidateTag("common-data", "max");
  revalidateTag("entries", "max");
  revalidatePath("/");
  revalidatePath("/overview");
  revalidatePath("/accounts");
}

export function revalidateAfterInvestChange() {
  revalidateAfterTxChange();
  revalidateTag("invest-account-data", "max");
  revalidateTag("fund-holding", "max");
  revalidatePath("/invest");
  revalidatePath("/funds");
  revalidatePath("/regular-invest");
}

export function revalidateAfterSettingsChange() {
  revalidateTag("common-data", "max");
  revalidatePath("/");
  revalidatePath("/accounts");
  revalidatePath("/settings/accounts");
  revalidatePath("/settings/institutions");
  revalidatePath("/settings/categories");
}
