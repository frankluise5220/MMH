"use client";

import { useEffect, useState } from "react";
import {
  APP_PREFS_EVENT,
  getDisplayLanguagePreference,
  setDisplayLanguagePreference,
  type DisplayLanguage,
} from "@/lib/client/appPreferences";

const LANGUAGE_OPTIONS: Array<{ value: DisplayLanguage; icon: string; label: string }> = [
  { value: "zh-CN", icon: "中", label: "中文" },
  { value: "en-US", icon: "EN", label: "English" },
  { value: "ja-JP", icon: "日", label: "日本語" },
];

function nextLanguage(current: DisplayLanguage) {
  const currentIndex = LANGUAGE_OPTIONS.findIndex((option) => option.value === current);
  return LANGUAGE_OPTIONS[(currentIndex + 1 + LANGUAGE_OPTIONS.length) % LANGUAGE_OPTIONS.length] ?? LANGUAGE_OPTIONS[0];
}

export function LanguageSwitcher() {
  const [language, setLanguage] = useState<DisplayLanguage>("zh-CN");

  useEffect(() => {
    function syncLanguage() {
      const next = getDisplayLanguagePreference();
      setLanguage(next);
      document.documentElement.lang = next;
    }
    syncLanguage();
    window.addEventListener(APP_PREFS_EVENT, syncLanguage);
    return () => window.removeEventListener(APP_PREFS_EVENT, syncLanguage);
  }, []);

  function switchLanguage(next: DisplayLanguage) {
    setLanguage(next);
    setDisplayLanguagePreference(next);
    document.documentElement.lang = next;
    void fetch("/api/v1/settings/app-preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayLanguage: next }),
    }).catch(() => {});
  }

  const current = LANGUAGE_OPTIONS.find((option) => option.value === language) ?? LANGUAGE_OPTIONS[0];
  const next = nextLanguage(language);

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        switchLanguage(next.value);
      }}
      title={`当前：${current.label}，点击切换到 ${next.label}`}
      aria-label={`当前：${current.label}，点击切换到 ${next.label}`}
      className="inline-flex h-7 min-w-7 items-center justify-center rounded-md px-1.5 text-[11px] font-semibold text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
    >
      {current.icon}
    </button>
  );
}
