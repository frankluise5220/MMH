"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { withBasePath } from "@/lib/base-path";
import { copyToClipboard } from "@/lib/client/clipboard";
import { AccessKeySettingsPanel } from "@/components/settings/AccessKeySettingsPanel";
import { SettingsPageHeader, SettingsSection, SettingsTable, SettingsTd, SettingsTh } from "@/components/settings/SettingsPageScaffold";

const BRIDGE_SCRIPT_URL = "https://github.com/frankluise5220/MMH/blob/main/scripts/mmh-mcp-stdio.cjs";

const TOOLS: { name: string; write?: boolean }[] = [
  { name: "mmh_list_accounts" },
  { name: "mmh_list_categories" },
  { name: "mmh_list_transactions" },
  { name: "mmh_get_investment_shell" },
  { name: "mmh_list_deposit_lots" },
  { name: "mmh_list_bond_lots" },
  { name: "mmh_query_investment_flow" },
  { name: "mmh_get_monthly_summary" },
  { name: "mmh_create_transaction", write: true },
  { name: "mmh_update_transaction", write: true },
  { name: "mmh_delete_transaction", write: true },
];

const PROMPT_KEYS = [
  "settings.mcp.prompt.line1",
  "settings.mcp.prompt.line2",
  "settings.mcp.prompt.line3",
  "settings.mcp.prompt.line4",
  "settings.mcp.prompt.line5",
  "settings.mcp.prompt.line6",
  "settings.mcp.prompt.line7",
  "settings.mcp.prompt.line8",
  "settings.mcp.prompt.line9",
  "settings.mcp.prompt.line10",
  "settings.mcp.prompt.line11",
  "settings.mcp.prompt.line12",
];

const NOTE_KEYS = [
  "settings.mcp.note1",
  "settings.mcp.note2",
  "settings.mcp.note3",
  "settings.mcp.note4",
];

function CopyButton({ text, label, copiedLabel }: { text: string; label: string; copiedLabel: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      className="secondary-button h-8 shrink-0 gap-1.5 px-2.5 text-xs"
      onClick={async () => {
        if (await copyToClipboard(text)) setCopied(true);
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? copiedLabel : label}
    </button>
  );
}

function CodeBlock({ text }: { text: string }) {
  return (
    <pre className="max-h-72 overflow-auto rounded-md border border-slate-200 bg-slate-900 p-3 text-[11px] leading-5 text-slate-100">
      <code>{text}</code>
    </pre>
  );
}

export default function McpGuidePage() {
  const { t } = useI18n();
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const endpoint = `${origin}${withBasePath("/api/v1/mcp")}`;
  const httpConfig = useMemo(
    () => JSON.stringify({
      mcpServers: {
        mmh: {
          type: "http",
          url: endpoint,
          headers: { Authorization: "Bearer <ACCESS_KEY>" },
        },
      },
    }, null, 2),
    [endpoint],
  );
  const stdioConfig = useMemo(
    () => JSON.stringify({
      mcpServers: {
        mmh: {
          type: "stdio",
          command: "node",
          args: ["<LOCAL_PATH>/mmh-mcp-stdio.cjs"],
          env: { MMH_MCP_URL: endpoint, MMH_MCP_KEY: "<ACCESS_KEY>" },
        },
      },
    }, null, 2),
    [endpoint],
  );
  const prompt = PROMPT_KEYS.map((key) => t(key)).join("\n");

  return (
    <div className="space-y-4">
      <SettingsPageHeader title={t("settings.mcp")} description={t("settings.mcp.description")} />

      <SettingsSection title={t("settings.mcp.prereqTitle")}>
        <div className="space-y-2 px-4 py-3 text-xs leading-5 text-slate-600">
          <p>{t("settings.mcp.prereqText")}</p>
        </div>
      </SettingsSection>

      <AccessKeySettingsPanel showHeader={false} />

      <SettingsSection title={t("settings.mcp.endpointTitle")}>
        <div className="space-y-3 px-4 py-3 text-xs leading-5 text-slate-600">
          <p>{t("settings.mcp.endpointText")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-[11px] text-slate-800">
              {endpoint}
            </code>
            <CopyButton text={endpoint} label={t("settings.externalApiKeys.copy")} copiedLabel={t("settings.mcp.copied")} />
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title={t("settings.mcp.httpTitle")}
        actions={<CopyButton text={httpConfig} label={t("settings.mcp.copyConfig")} copiedLabel={t("settings.mcp.copied")} />}
      >
        <div className="space-y-3 px-4 py-3 text-xs leading-5 text-slate-600">
          <p>{t("settings.mcp.httpText")}</p>
          <CodeBlock text={httpConfig} />
        </div>
      </SettingsSection>

      <SettingsSection
        title={t("settings.mcp.stdioTitle")}
        actions={<CopyButton text={stdioConfig} label={t("settings.mcp.copyConfig")} copiedLabel={t("settings.mcp.copied")} />}
      >
        <div className="space-y-3 px-4 py-3 text-xs leading-5 text-slate-600">
          <p>{t("settings.mcp.stdioText")}</p>
          <a href={BRIDGE_SCRIPT_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-blue-600 hover:underline">
            {t("settings.mcp.bridgeLink")}
            <ExternalLink className="h-3 w-3" />
          </a>
          <CodeBlock text={stdioConfig} />
        </div>
      </SettingsSection>

      <SettingsSection title={t("settings.mcp.toolsTitle")}>
        <div className="space-y-3 px-4 py-3">
          <p className="text-xs leading-5 text-slate-600">{t("settings.mcp.toolsText")}</p>
          <SettingsTable minWidth={720}>
            <thead>
              <tr>
                <SettingsTh>{t("settings.mcp.toolName")}</SettingsTh>
                <SettingsTh>{t("settings.mcp.toolScope")}</SettingsTh>
                <SettingsTh>{t("settings.mcp.toolPurpose")}</SettingsTh>
              </tr>
            </thead>
            <tbody>
              {TOOLS.map((tool) => (
                <tr key={tool.name} className="hover:bg-slate-50">
                  <SettingsTd className="font-mono text-[11px] text-slate-700">{tool.name}</SettingsTd>
                  <SettingsTd>
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${tool.write ? "bg-amber-50 text-amber-700" : "bg-slate-100 text-slate-600"}`}>
                      {tool.write ? t("settings.mcp.scopeWrite") : t("settings.mcp.scopeRead")}
                    </span>
                  </SettingsTd>
                  <SettingsTd>{t(`settings.mcp.tool.${tool.name}`)}</SettingsTd>
                </tr>
              ))}
            </tbody>
          </SettingsTable>
        </div>
      </SettingsSection>

      <SettingsSection
        title={t("settings.mcp.promptTitle")}
        actions={<CopyButton text={prompt} label={t("settings.externalApiKeys.copy")} copiedLabel={t("settings.mcp.copied")} />}
      >
        <div className="space-y-3 px-4 py-3 text-xs leading-5 text-slate-600">
          <p>{t("settings.mcp.promptText")}</p>
          <CodeBlock text={prompt} />
        </div>
      </SettingsSection>

      <SettingsSection title={t("settings.mcp.notesTitle")}>
        <ul className="list-disc space-y-2 px-8 py-3 text-xs leading-5 text-slate-600">
          {NOTE_KEYS.map((key) => <li key={key}>{t(key)}</li>)}
        </ul>
      </SettingsSection>
    </div>
  );
}
