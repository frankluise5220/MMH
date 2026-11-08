"use client";
import { AccessKeySettingsPanel } from "@/components/settings/AccessKeySettingsPanel";

/** Legacy URL kept for bookmarks; the settings catalog now points at /settings/mcp. */
export default function ApiKeysPage() {
  return <AccessKeySettingsPanel />;
}
