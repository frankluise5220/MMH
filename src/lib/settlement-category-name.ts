/**
 * Settlement (借入借出) category naming, kept free of any database dependency.
 *
 * Client components need this normalization, and `default-categories.ts` pulls
 * in Prisma — importing it from a client bundle drags `better-sqlite3` (and
 * therefore `fs`) into the browser build. Keeping the pure piece here lets both
 * sides share one implementation.
 */
export const SYSTEM_SETTLEMENT_TRANSFER_CATEGORY = "借入借出";

const legacySettlementTransferActionCategoryNames = new Set([
  "往来款",
  "还款",
  "提前还款",
  "贷款还款",
  "借入",
  "借出",
  "出借",
  "收回",
]);

export function normalizeSettlementTransferCategoryName(categoryName?: string | null) {
  const name = String(categoryName ?? "").trim();
  if (!name || legacySettlementTransferActionCategoryNames.has(name)) return SYSTEM_SETTLEMENT_TRANSFER_CATEGORY;
  return name;
}
