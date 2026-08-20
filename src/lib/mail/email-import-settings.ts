export const DEFAULT_EMAIL_IMPORT_KEYWORD = "\u8d26\u5355";
export const EMAIL_IMPORT_KEYWORD_SETTING_PREFIX = "email_import_keyword:";

export function emailImportKeywordSettingKey(householdId: string) {
  return `${EMAIL_IMPORT_KEYWORD_SETTING_PREFIX}${householdId}`;
}

export function normalizeEmailImportKeyword(value: unknown) {
  const keyword = String(value ?? "").trim().replace(/\s+/g, " ");
  return (keyword || DEFAULT_EMAIL_IMPORT_KEYWORD).slice(0, 40);
}
