// Server-side i18n helper: lets server components render translated strings.
// Reads the display-language cookie and returns a `t` function backed by the
// shared pure core (`src/lib/i18n-core.ts`). Do not use this in client
// components — use `useI18n()` from `@/lib/i18n` there.
import { cookies } from "next/headers";
import { translate } from "@/lib/i18n-core";
import type { DisplayLanguage } from "@/lib/client/appPreferences";
import { DEFAULT_DISPLAY_LANGUAGE } from "@/lib/preferences";

export const DISPLAY_LANGUAGE_COOKIE = "mmh_display_language";

type T = (key: string, params?: Record<string, string | number>) => string;

export async function getServerDisplayLanguage(): Promise<DisplayLanguage> {
  const store = await cookies();
  const raw = store.get(DISPLAY_LANGUAGE_COOKIE)?.value;
  return raw === "en-US" || raw === "ja-JP" ? raw : "zh-CN";
}

export async function getServerT(): Promise<T> {
  const lang = await getServerDisplayLanguage();
  return (key, params) => translate(lang, key, params);
}

/**
 * 给「也可能在后台定时任务里跑」的服务端执行器用。
 *
 * `getServerT()` 依赖 `cookies()`，在 instrumentation 的定时轮次里没有请求作用域，
 * 调用会抛错；而定时任务现在要跑存款到期/取息（跑不动就等于永远不生息）。
 * 这里在拿不到 cookie 时退回**账簿设置里的显示语言**，连账簿都读不到才用默认中文。
 * 只影响自动生成文案（如「存款利息 · X」）的语言，不参与任何账务口径。
 */
export async function getServerTSafe(householdId?: string | null): Promise<T> {
  try {
    return await getServerT();
  } catch {
    const language = await householdDisplayLanguage(householdId);
    return (key, params) => translate(language, key, params);
  }
}

async function householdDisplayLanguage(householdId?: string | null) {
  if (!householdId) return DEFAULT_DISPLAY_LANGUAGE;
  try {
    const [{ prisma }, { preferencesFromRow }] = await Promise.all([
      import("@/lib/db/prisma"),
      import("@/lib/preferences"),
    ]);
    const row = await prisma.householdPreference.findUnique({ where: { householdId } });
    return preferencesFromRow(row).displayLanguage;
  } catch {
    return DEFAULT_DISPLAY_LANGUAGE;
  }
}
