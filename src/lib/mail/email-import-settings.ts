export const DEFAULT_EMAIL_IMPORT_KEYWORD = "\u8d26\u5355";
/** Setting name without the household suffix; `SystemSetting` has no householdId column, so the ledger is part of the key. */
export const EMAIL_IMPORT_KEYWORD_SETTING_NAME = "email_import_keyword";

export function normalizeEmailImportKeyword(value: unknown, options?: { fallbackToDefault?: boolean }) {
  const keyword = String(value ?? "").trim().replace(/\s+/g, " ");
  const normalized = keyword.slice(0, 40);
  return normalized || (options?.fallbackToDefault ? DEFAULT_EMAIL_IMPORT_KEYWORD : "");
}
