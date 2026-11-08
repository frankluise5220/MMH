"use client";

import { useEffect, useState } from "react";

import {
  SETTINGS_DATA_CHANGED_EVENT,
  type SettingsDataChangedDetail,
  type SettingsDataScope,
} from "@/lib/client/settingsCache";

/**
 * Counter bumped whenever a settings write publishes
 * SETTINGS_DATA_CHANGED_EVENT for the requested scope ("accounts" carries
 * accounts, groups, institutions, counterparties and users). Put it in an
 * effect dependency list so option lists that stay mounted for a whole session
 * (entry dialogs, settings panels) refetch instead of keeping a stale snapshot.
 */
export function useSettingsDataVersion(scope: SettingsDataScope = "accounts") {
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const onSettingsChanged = (event: Event) => {
      const detail = (event as CustomEvent<SettingsDataChangedDetail>).detail;
      const changed = detail?.scope ?? "all";
      if (changed === "all" || changed === scope) {
        setVersion((current) => current + 1);
      }
    };
    window.addEventListener(SETTINGS_DATA_CHANGED_EVENT, onSettingsChanged as EventListener);
    return () => {
      window.removeEventListener(SETTINGS_DATA_CHANGED_EVENT, onSettingsChanged as EventListener);
    };
  }, [scope]);

  return version;
}
