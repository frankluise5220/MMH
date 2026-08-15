// Server-side i18n helper: lets server components render translated strings.
// Reads the display-language cookie and returns a `t` function backed by the
// shared pure core (`src/lib/i18n-core.ts`). Do not use this in client
// components — use `useI18n()` from `@/lib/i18n` there.
import { cookies } from "next/headers";
import { translate } from "@/lib/i18n-core";

export const DISPLAY_LANGUAGE_COOKIE = "mmh_display_language";

type T = (key: string, params?: Record<string, string | number>) => string;

export async function getServerT(): Promise<T> {
  const store = await cookies();
  const raw = store.get(DISPLAY_LANGUAGE_COOKIE)?.value;
  const lang = raw === "en-US" || raw === "ja-JP" ? raw : "zh-CN";
  return (key, params) => translate(lang, key, params);
}
