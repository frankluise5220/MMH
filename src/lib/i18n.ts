"use client";

import { useEffect, useMemo, useState } from "react";
import { APP_PREFS_EVENT, getDisplayLanguagePreference, type DisplayLanguage } from "@/lib/client/appPreferences";
import { translate } from "@/lib/i18n-core";

export { translate };
export type { I18nKey } from "@/lib/i18n-core";

export function useI18n() {
  const [language, setLanguage] = useState<DisplayLanguage>("zh-CN");

  useEffect(() => {
    function syncLanguage() {
      setLanguage(getDisplayLanguagePreference());
    }
    syncLanguage();
    window.addEventListener(APP_PREFS_EVENT, syncLanguage);
    return () => window.removeEventListener(APP_PREFS_EVENT, syncLanguage);
  }, []);

  return useMemo(() => ({
    language,
    t: (key: string, params?: Record<string, string | number>) => translate(language, key, params),
  }), [language]);
}

