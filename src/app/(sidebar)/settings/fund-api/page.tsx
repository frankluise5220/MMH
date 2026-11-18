"use client";
import { ModalLayer } from "@/components/ModalLayer";

import { useState, useEffect, type DragEvent } from "react";
import { Power, PowerOff, X } from "lucide-react";
import { showConfirmDialog } from "@/lib/client/confirm-dialog";
import {
  SettingsActionButton,
  SettingsEmptyRow,
  SettingsPageHeader,
  SettingsPrimaryAddButton,
  SettingsRowActions,
  SettingsSection,
  SettingsTable,
  SettingsTd,
  SettingsTh,
} from "@/components/settings/SettingsPageScaffold";
import { parseBaseUrl, buildBaseUrl, PROTOCOL_OPTIONS, PORT_SUGGESTIONS } from "@/lib/urlInput";
import type { ParsedUrl } from "@/lib/urlInput";
import { FUND_PARSER_CODES, inferFundParserCode, isKnownFundParserCode, type FundParserCode } from "@/lib/fund/parser-code";
import { useI18n } from "@/lib/i18n";

type FundQueryApiRecord = {
  id: string;
  code: string;
  /** 解析器标识；为空时沿用 `code`（存量行 `code` 本身就是解析器）。 */
  parser?: string | null;
  parserConfig?: unknown;
  name: string;
  baseUrl: string;
  apiKey: string | null;
  priority: number;
  isActive: boolean;
  householdId: string | null;
};

type EditForm = Omit<Partial<FundQueryApiRecord>, "baseUrl"> & {
  urlParts: ParsedUrl;
};

/** 表单里的 `code` 实际承载「解析器」：回填优先用 `parser` 列。 */
function makeForm(api?: Partial<FundQueryApiRecord> | null): EditForm {
  return {
    code: (api?.parser ?? api?.code) ?? "",
    name: api?.name ?? "",
    urlParts: parseBaseUrl(api?.baseUrl),
    apiKey: api?.apiKey ?? "",
    priority: api?.priority ?? 0,
    isActive: api?.isActive ?? true,
  };
}

function flatForm(f: EditForm): Omit<EditForm, "urlParts"> & { baseUrl: string } {
  return {
    code: f.code,
    parser: f.code,
    name: f.name,
    baseUrl: buildBaseUrl(f.urlParts),
    apiKey: f.apiKey,
    priority: f.priority,
    isActive: f.isActive,
  };
}

/** 测试失败原因码 → i18n key，后端只回码，文案在语言包里 */
const TEST_FAIL_REASON_KEYS: Record<string, string> = {
  UNKNOWN_PARSER: "settings.fundApi.testFailUnknownParser",
  MISSING_PLACEHOLDER: "settings.fundApi.testFailMissingPlaceholder",
  INVALID_FUND_CODE: "settings.fundApi.testFailInvalidFundCode",
  NO_DATA: "settings.fundApi.testFailNoData",
  REQUEST_FAILED: "settings.fundApi.testFailRequest",
};

/** 解析器 → 下拉文案 key。地址认不出来时用户从这里选。 */
const PARSER_LABEL_KEYS: Record<FundParserCode, string> = {
  eastmoney: "settings.fundApi.parserEastmoney",
  eastmoney_history: "settings.fundApi.parserEastmoneyHistory",
  danjuan: "settings.fundApi.parserDanjuan",
  alipay: "settings.fundApi.parserAlipay",
  json: "settings.fundApi.parserJson",
};

function sortApis(apis: FundQueryApiRecord[]) {
  return [...apis].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name, "zh-Hans-CN"));
}

function reorderApis(apis: FundQueryApiRecord[], sourceId: string, targetId: string) {
  const next = [...apis];
  const from = next.findIndex((api) => api.id === sourceId);
  const to = next.findIndex((api) => api.id === targetId);
  if (from < 0 || to < 0 || from === to) return apis;
  const [moved] = next.splice(from, 1);
  if (!moved) return apis;
  next.splice(to, 0, moved);
  return next.map((api, index) => ({ ...api, priority: index + 1 }));
}

function UrlInputGroup({
  value,
  onChange,
}: {
  value: ParsedUrl;
  onChange: (next: ParsedUrl) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <select
          value={value.protocol}
          onChange={e => onChange({ ...value, protocol: e.target.value })}
          className="h-9 rounded-md border border-slate-200 bg-white px-2.5 text-sm outline-none shrink-0"
        >
          {PROTOCOL_OPTIONS.map(op => (
            <option key={op.value} value={op.value}>{op.label}</option>
          ))}
        </select>
        <span className="text-slate-300 text-sm font-mono">://</span>
        <input
          value={value.host}
          onChange={e => onChange({ ...value, host: e.target.value })}
          placeholder="fund.example.com"
          className="h-9 flex-1 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none font-mono"
        />
        <span className="text-slate-300 text-sm font-mono">:</span>
        <input
          value={value.port}
          onChange={e => onChange({ ...value, port: e.target.value })}
          type="number"
          placeholder={t("settings.fundApi.port")}
          list="port-suggestions"
          className="h-9 w-24 rounded-md border border-slate-200 bg-white px-2.5 text-sm outline-none font-mono"
        />
        <datalist id="port-suggestions">
          {PORT_SUGGESTIONS.filter(s => s.value).map(s => (
            <option key={s.value} value={s.value}>{t(s.labelKey)}</option>
          ))}
        </datalist>
      </div>
      <div>
        <input
          value={value.path}
          onChange={e => onChange({ ...value, path: e.target.value })}
          placeholder={t("settings.fundApi.pathPlaceholder")}
          className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none font-mono"
        />
      </div>
    </div>
  );
}

export default function FundQueryApiPage() {
  const { t } = useI18n();
  const [apis, setApis] = useState<FundQueryApiRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<EditForm>(makeForm());
  const [saving, setSaving] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  // 解析器不再让用户手填：能从地址认出来就用认出来的，认不出才用他手动选的那个。
  // 编辑态 code 不允许改（PUT 也不接收 code），固定用原值，只做「是否存在」的提示。
  const isCreateMode = editingId === "__new__";
  const formUrl = buildBaseUrl(form.urlParts);
  const inferredCode = inferFundParserCode(formUrl);
  const effectiveCode = isCreateMode ? (inferredCode ?? (form.code ?? "").trim()) : (form.code ?? "").trim();
  // 地址或解析器一改，上一次的测试结论就作废，必须重新测。
  useEffect(() => {
    setTestResult(null);
  }, [effectiveCode, formUrl]);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/v1/settings/fund-query-api", { signal: controller.signal })
      .then(async (r) => {
        const text = await r.text();
        let payload: { ok?: boolean; apis?: FundQueryApiRecord[]; error?: string } | { raw: string } = { raw: "" };
        try {
          payload = JSON.parse(text) as { ok?: boolean; apis?: FundQueryApiRecord[]; error?: string };
        } catch {
          payload = { raw: text.slice(0, 200) };
        }
        return { status: r.status, ok: r.ok, payload };
      })
      .then(({ status, payload }) => {
        if ("ok" in payload && payload.ok) {
          setApis(sortApis(Array.isArray(payload.apis) ? payload.apis : []));
          setLoadError("");
        } else {
          setApis([]);
          const hint = "ok" in payload ? (payload.error || t("settings.fundApi.requestFailed", { status })) : t("settings.fundApi.requestFailed", { status });
          setLoadError(hint);
        }
      })
      .catch((error) => {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
        setApis([]);
        setLoadError(t("settings.fundApi.networkFailed"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  function openEdit(api: FundQueryApiRecord) {
    setEditingId(api.id);
    setForm(makeForm(api));
    setTestResult(null);
  }

  function openCreate() {
    setEditingId("__new__");
    setForm(makeForm({ code: "", name: "", priority: apis.length + 1, isActive: true }));
    setTestResult(null);
  }

  async function saveOrder(nextApis: FundQueryApiRecord[]) {
    setSaving(true);
    try {
      const res = await fetch("/api/v1/settings/fund-query-api", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          priorities: nextApis.map((api, index) => ({ id: api.id, priority: index + 1 })),
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setApis(sortApis(Array.isArray(data.apis) ? data.apis : nextApis));
        return true;
      } else {
        alert(data.error || t("settings.fundApi.orderSaveFailed"));
        return false;
      }
    } catch {
      alert(t("settings.fundApi.orderSaveFailed"));
      return false;
    } finally {
      setSaving(false);
    }
  }

  function handleDragStart(event: DragEvent<HTMLTableRowElement>, id: string) {
    setDraggingId(id);
    setDragOverId(null);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", id);
    const ghost = event.currentTarget.cloneNode(true) as HTMLElement;
    ghost.style.width = `${event.currentTarget.offsetWidth}px`;
    ghost.style.border = "2px solid rgb(37 99 235)";
    ghost.style.borderRadius = "0.375rem";
    ghost.style.boxShadow = "0 18px 45px rgba(15, 23, 42, 0.22)";
    ghost.style.background = "white";
    ghost.style.opacity = "0.98";
    ghost.style.display = "table";
    ghost.style.position = "fixed";
    ghost.style.top = "-1000px";
    ghost.style.left = "-1000px";
    ghost.style.pointerEvents = "none";
    document.body.appendChild(ghost);
    event.dataTransfer.setDragImage(ghost, 28, 28);
    window.setTimeout(() => ghost.remove(), 0);
  }

  function handleDragOver(event: DragEvent<HTMLTableRowElement>, id: string) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (draggingId && draggingId !== id) setDragOverId(id);
  }

  function handleDragLeave(event: DragEvent<HTMLTableRowElement>, id: string) {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    if (dragOverId === id) setDragOverId(null);
  }

  async function handleDrop(event: DragEvent<HTMLTableRowElement>, targetId: string) {
    event.preventDefault();
    const sourceId = draggingId || event.dataTransfer.getData("text/plain");
    setDraggingId(null);
    setDragOverId(null);
    if (!sourceId || sourceId === targetId || saving) return;
    const previous = apis;
    const next = reorderApis(apis, sourceId, targetId);
    if (next === apis) return;
    setApis(next);
    const saved = await saveOrder(next);
    if (!saved) setApis(previous);
  }

  async function testConnection() {
    if (testing || saving) return;
    const baseUrl = buildBaseUrl(form.urlParts).trim();
    const code = effectiveCode;
    if (!code) {
      setTestResult({ ok: false, text: t("settings.fundApi.parserRequired") });
      return;
    }
    if (!baseUrl) {
      setTestResult({ ok: false, text: t("settings.fundApi.testFailMissingPlaceholder") });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/v1/settings/fund-query-api/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, baseUrl }),
      });
      const data = await res.json();
      if (data.ok) {
        setTestResult({
          ok: true,
          text: t("settings.fundApi.testPassed", {
            fund: String(data.fundCode ?? ""),
            date: String(data.navDate ?? ""),
            nav: String(data.nav ?? ""),
          }),
        });
        return;
      }
      const reasonKey = TEST_FAIL_REASON_KEYS[String(data.reason ?? "")];
      setTestResult({
        ok: false,
        text: reasonKey
          ? t(reasonKey, { code, message: String(data.message ?? ""), fund: String(data.fundCode ?? "") })
          : String(data.message ?? t("settings.fundApi.testFailRequest", { message: "" })),
      });
    } catch {
      setTestResult({ ok: false, text: t("settings.fundApi.testFailRequest", { message: "" }) });
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    if (!editingId) return;
    if (!effectiveCode) {
      alert(t("settings.fundApi.parserRequired"));
      return;
    }
    if (editingId === "__new__" && !testResult?.ok) {
      alert(t("settings.fundApi.testRequired"));
      return;
    }
    setSaving(true);
    try {
      const isCreate = editingId === "__new__";
      const flat = { ...flatForm(form), code: effectiveCode };
      const body = isCreate ? flat : { id: editingId, ...flat };
      const res = await fetch("/api/v1/settings/fund-query-api", {
        method: isCreate ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok) {
        if (isCreate && data.api) {
          setApis(prev => [...prev, data.api].sort((a, b) => a.priority - b.priority));
        } else {
          setApis(prev => prev.map(a => a.id === editingId ? { ...a, ...flat } as FundQueryApiRecord : a));
        }
        setEditingId(null);
        setForm(makeForm());
      } else {
        alert(data.error || t("settings.fundApi.saveFailed"));
      }
    } catch {
      alert(t("settings.fundApi.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(api: FundQueryApiRecord) {
    setSaving(true);
    try {
      const res = await fetch("/api/v1/settings/fund-query-api", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: api.id, isActive: !api.isActive }),
      });
      const data = await res.json();
      if (data.ok) {
        setApis(prev => prev.map(a => a.id === api.id ? { ...a, isActive: !a.isActive } : a));
      }
    } catch {
      alert(t("settings.fundApi.actionFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(api: FundQueryApiRecord) {
    if (api.householdId == null || saving) return;
    const confirmed = await showConfirmDialog({
      title: t("settings.fundApi.deleteApi"),
      message: t("settings.fundApi.deleteConfirm", { name: api.name }),
      tone: "danger",
    });
    if (!confirmed) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/v1/settings/fund-query-api?id=${encodeURIComponent(api.id)}`, { method: "DELETE" });
      const data = await res.json();
      if (data.ok) {
        const next = apis.filter(a => a.id !== api.id);
        setApis(next);
        await saveOrder(next);
      } else {
        alert(data.error || t("settings.fundApi.deleteFailed"));
      }
    } catch {
      alert(t("settings.fundApi.deleteFailed"));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="text-sm text-slate-400">{t("common.loading")}</div>;
  }

  const isCreating = editingId === "__new__";
  const editingApi = editingId && !isCreating ? apis.find((api) => api.id === editingId) ?? null : null;

  return (
    <div className="space-y-4">
      <SettingsPageHeader
        title={t("settings.fundApi.title")}
        description={t("settings.fundApi.description")}
        count={apis.length}
      />

      {loadError && (
        <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
          {loadError}
        </div>
      )}

      <SettingsSection
        title={t("settings.fundApi.listTitle")}
        count={apis.length}
        actions={<SettingsPrimaryAddButton onClick={openCreate}>{t("settings.fundApi.add")}</SettingsPrimaryAddButton>}
      >
      <SettingsTable minWidth={920} maxWidth="full">
        <colgroup>
          <col className="w-[4.5rem]" />
          <col className="w-[13rem]" />
          <col className="w-[9rem]" />
          <col />
          <col className="w-[6rem]" />
          <col className="w-[6.5rem]" />
        </colgroup>
        <thead className="sticky top-0 z-10">
          <tr>
            <SettingsTh align="center">{t("settings.fundApi.order")}</SettingsTh>
            <SettingsTh>{t("settings.fundApi.name")}</SettingsTh>
            <SettingsTh>{t("settings.fundApi.parser")}</SettingsTh>
            <SettingsTh>{t("settings.fundApi.url")}</SettingsTh>
            <SettingsTh>{t("settings.fundApi.status")}</SettingsTh>
            <SettingsTh align="right">{t("settings.fundApi.actions")}</SettingsTh>
          </tr>
        </thead>
        <tbody>
          {apis.length > 0 ? apis.map((api, index) => (
            <tr
              key={api.id}
              draggable={editingId === null && !saving}
              onDragStart={(event) => handleDragStart(event, api.id)}
              onDragEnd={() => { setDraggingId(null); setDragOverId(null); }}
              onDragOver={(event) => handleDragOver(event, api.id)}
              onDragLeave={(event) => handleDragLeave(event, api.id)}
              onDrop={(event) => handleDrop(event, api.id)}
              className={[
                api.isActive ? "hover:bg-slate-50" : "bg-slate-50/70 opacity-70",
                draggingId === api.id ? "bg-blue-50/80 opacity-95 ring-2 ring-inset ring-blue-200" : "",
                dragOverId === api.id && draggingId !== api.id ? "bg-blue-50 ring-2 ring-inset ring-blue-300" : "",
              ].join(" ")}
            >
              <SettingsTd align="center">
                <span className="inline-flex h-7 w-7 cursor-grab select-none items-center justify-center rounded-md border border-slate-200 bg-slate-50 text-xs font-semibold text-slate-500 active:cursor-grabbing">
                  {index + 1}
                </span>
              </SettingsTd>
              <SettingsTd className="text-sm font-medium text-slate-800">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate">{api.name}</span>
                  {api.householdId == null ? (
                    <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-normal text-slate-600">{t("settings.fundApi.builtIn")}</span>
                  ) : null}
                  {(api.parser ?? api.code) === "alipay" ? (
                    <span className="shrink-0 rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-normal text-blue-700">{t("settings.fundApi.alipayPriority")}</span>
                  ) : null}
                </div>
              </SettingsTd>
              <SettingsTd className="font-mono text-[11px]">
                {isKnownFundParserCode(api.parser ?? api.code) ? (
                  <span className="text-slate-500">{api.parser ?? api.code}</span>
                ) : (
                  <span className="text-red-600" title={t("settings.fundApi.parserMissingRow")}>{api.parser ?? api.code}</span>
                )}
              </SettingsTd>
              <SettingsTd className="truncate font-mono text-[11px] text-slate-400" title={api.baseUrl}>{api.baseUrl}</SettingsTd>
              <SettingsTd>
                <span className={`rounded px-2 py-0.5 text-xs ${api.isActive ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
                  {api.isActive ? t("common.enabled") : t("common.disabled")}
                </span>
              </SettingsTd>
              <SettingsTd align="right">
                <SettingsRowActions>
                  <SettingsActionButton
                    label={api.isActive ? t("settings.fundApi.disableApi") : t("settings.fundApi.enableApi")}
                    icon={api.isActive ? <PowerOff className="h-3.5 w-3.5" /> : <Power className="h-3.5 w-3.5" />}
                    onClick={() => toggleActive(api)}
                    disabled={saving}
                  />
                  <SettingsActionButton label={t("settings.fundApi.editApi")} variant="edit" onClick={() => openEdit(api)} />
                  {api.householdId != null ? (
                    <SettingsActionButton
                      label={t("settings.fundApi.deleteApi")}
                      variant="delete"
                      onClick={() => handleDelete(api)}
                      disabled={saving}
                    />
                  ) : null}
                </SettingsRowActions>
              </SettingsTd>
            </tr>
          )) : (
            <SettingsEmptyRow colSpan={6}>{t("settings.fundApi.empty")}</SettingsEmptyRow>
          )}
        </tbody>
      </SettingsTable>
      </SettingsSection>

      {(isCreating || editingApi) ? (
        <ModalLayer className="app-modal-backdrop">
          <div className="app-modal-panel max-w-2xl">
            <div className="modal-header shrink-0">
              <div className="text-sm font-semibold text-slate-800">{isCreating ? t("settings.fundApi.addTitle") : t("settings.fundApi.editTitle")}</div>
              <button type="button" onClick={() => { setEditingId(null); setForm(makeForm()); }}
                className="secondary-button inline-flex h-8 w-8 items-center justify-center px-0"
                aria-label={t("table.close")} title={t("table.close")}>
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3 p-5">
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-600">{t("settings.fundApi.name")}</div>
                <input value={form.name ?? ""} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">{t("settings.fundApi.parser")}</div>
                  {isCreating && !inferredCode ? (
                    <select
                      value={form.code ?? ""}
                      onChange={e => setForm(f => ({ ...f, code: e.target.value }))}
                      className="h-9 w-full rounded-md border border-amber-300 bg-white px-3 text-sm outline-none"
                    >
                      <option value="">{t("settings.fundApi.parserPlaceholder")}</option>
                      {FUND_PARSER_CODES.map((parserCode) => (
                        <option key={parserCode} value={parserCode}>{t(PARSER_LABEL_KEYS[parserCode])}</option>
                      ))}
                    </select>
                  ) : (
                    <div className="flex h-9 items-center gap-2 rounded-md border border-slate-100 bg-slate-50 px-3 text-sm">
                      <span className="shrink-0 font-mono text-[11px] text-slate-500">{effectiveCode || t("settings.fundApi.parserPlaceholder")}</span>
                      {inferredCode ? (
                        <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] text-emerald-700">{t("settings.fundApi.parserAuto")}</span>
                      ) : null}
                    </div>
                  )}
                  <div className={`text-xs ${effectiveCode ? "text-slate-400" : "text-amber-600"}`}>
                    {inferredCode
                      ? t("settings.fundApi.parserAutoHint")
                      : effectiveCode
                        ? t("settings.fundApi.parserMissingRow")
                        : t("settings.fundApi.parserUnknown")}
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">{t("settings.fundApi.order")}</div>
                  <div className="flex h-9 items-center rounded-md border border-slate-100 bg-slate-50 px-3 text-sm text-slate-500">
                    {isCreating ? t("settings.fundApi.dragAfterCreate") : t("settings.fundApi.positionInfo", { position: apis.findIndex((api) => api.id === editingId) + 1 })}
                  </div>
                </div>
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-600">{t("settings.fundApi.url")}</div>
                <UrlInputGroup value={form.urlParts} onChange={next => setForm(f => ({ ...f, urlParts: next }))} />
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={testConnection}
                    disabled={testing || saving}
                    className="h-8 rounded-md border border-slate-200 bg-white px-3 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    {testing ? t("settings.fundApi.testing") : t("settings.fundApi.test")}
                  </button>
                  {testResult ? (
                    <span className={`text-xs ${testResult.ok ? "text-emerald-600" : "text-red-600"}`}>{testResult.text}</span>
                  ) : (
                    <span className="text-xs text-slate-400">{t("settings.fundApi.testHint")}</span>
                  )}
                </div>
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-600">{t("settings.fundApi.apiKey")}</div>
                <input value={form.apiKey ?? ""} onChange={e => setForm(f => ({ ...f, apiKey: e.target.value }))}
                  className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
              </div>
              <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
                <button onClick={save} disabled={saving || !effectiveCode || (isCreating && !testResult?.ok)}
                  title={!effectiveCode ? t("settings.fundApi.parserRequired") : isCreating && !testResult?.ok ? t("settings.fundApi.testRequired") : undefined}
                  className="h-9 rounded-md bg-blue-600 px-4 text-sm text-white hover:bg-blue-700 disabled:opacity-50">{isCreating ? t("settings.fundApi.create") : t("common.save")}</button>
              </div>
            </div>
          </div>
        </ModalLayer>
      ) : null}
    </div>
  );
}
