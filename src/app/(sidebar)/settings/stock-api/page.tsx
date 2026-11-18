"use client";

import { useCallback, useEffect, useState } from "react";
import { Power, PowerOff, X } from "lucide-react";
import { ModalLayer } from "@/components/ModalLayer";
import { showConfirmDialog } from "@/lib/client/confirm-dialog";
import { todayDateLocalYmd } from "@/lib/date-utils";
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
import { useI18n } from "@/lib/i18n";

type StockQuoteApiRecord = {
  id: string;
  code: string;
  name: string;
  market: string;
  baseUrl: string;
  apiKey: string | null;
  parser: string | null;
  parserConfig: unknown;
  priority: number;
  isActive: boolean;
  builtin: boolean;
  householdId: string | null;
};

const PARSER_CODES = ["eastmoney_kline", "tencent_kline", "json"] as const;

/** 测试连接用的示例代码，选市场时顺手带出来。 */
const MARKET_TEST_CODES: Record<string, string> = {
  CN: "600519",
  HK: "00700",
  US: "AAPL",
  "*": "600519",
};

type ParserCode = (typeof PARSER_CODES)[number];

type FormState = {
  name: string;
  market: string;
  parser: ParserCode;
  baseUrl: string;
  apiKey: string;
  priority: number;
  isActive: boolean;
  authIn: "none" | "header" | "query";
  authName: string;
  authPrefix: string;
  pricePath: string;
  datePath: string;
  seriesPath: string;
  seriesPricePath: string;
  seriesDatePath: string;
};

type TestResult = {
  ok: boolean;
  outcome?: string;
  stockCode?: string;
  date?: string;
  priceDate?: string;
  closePrice?: number;
  candidates?: Array<{ priceDate: string; closePrice: number }>;
  message?: string | null;
  raw?: string | null;
};

function todayYmd(): string {
  return todayDateLocalYmd();
}

function parserOf(api?: Partial<StockQuoteApiRecord> | null): ParserCode {
  const value = (api?.parser ?? api?.code ?? "") as ParserCode;
  return PARSER_CODES.includes(value) ? value : "json";
}

function readConfig(api?: Partial<StockQuoteApiRecord> | null): Record<string, unknown> {
  const raw = api?.parserConfig;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

function makeForm(api?: Partial<StockQuoteApiRecord> | null): FormState {
  const config = readConfig(api);
  const authInRaw = String(config.authIn ?? "none");
  return {
    name: api?.name ?? "",
    market: api?.market ?? "CN",
    parser: parserOf(api),
    baseUrl: api?.baseUrl ?? "",
    apiKey: api?.apiKey ?? "",
    priority: api?.priority ?? 0,
    isActive: api?.isActive ?? true,
    authIn: authInRaw === "header" || authInRaw === "query" ? authInRaw : "none",
    authName: String(config.authName ?? ""),
    authPrefix: String(config.authPrefix ?? ""),
    pricePath: String(config.pricePath ?? ""),
    datePath: String(config.datePath ?? ""),
    seriesPath: String(config.seriesPath ?? ""),
    seriesPricePath: String(config.seriesPricePath ?? ""),
    seriesDatePath: String(config.seriesDatePath ?? ""),
  };
}

function buildParserConfig(form: FormState): Record<string, unknown> | null {
  if (form.parser !== "json") return null;
  return {
    authIn: form.authIn,
    authName: form.authName.trim(),
    authPrefix: form.authPrefix,
    pricePath: form.pricePath.trim(),
    datePath: form.datePath.trim(),
    seriesPath: form.seriesPath.trim(),
    seriesPricePath: form.seriesPricePath.trim(),
    seriesDatePath: form.seriesDatePath.trim(),
  };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-slate-600">{label}</div>
      {children}
    </div>
  );
}

const inputClass = "h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none";

export default function StockApiSettingsPage() {
  const { t } = useI18n();
  const [apis, setApis] = useState<StockQuoteApiRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(makeForm());
  const [testCode, setTestCode] = useState("600519");
  const [testDate, setTestDate] = useState(todayYmd());
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isCreating = editingId === "__new__";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/v1/settings/stock-quote-api", { cache: "no-store" });
      const data = await res.json();
      if (data?.ok) setApis(data.apis ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openCreate() {
    setEditingId("__new__");
    setForm(makeForm());
    setTestResult(null);
    setError(null);
  }

  function openEdit(api: StockQuoteApiRecord) {
    setEditingId(api.id);
    setForm(makeForm(api));
    setTestResult(null);
    setError(null);
  }

  function closeModal() {
    setEditingId(null);
    setTestResult(null);
    setError(null);
  }

  async function runTest() {
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const res = await fetch("/api/v1/settings/stock-quote-api/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parser: form.parser,
          parserConfig: buildParserConfig(form),
          baseUrl: form.baseUrl.trim(),
          apiKey: form.apiKey.trim() || undefined,
          market: form.market,
          stockCode: testCode.trim(),
          date: testDate,
        }),
      });
      const data = (await res.json()) as TestResult;
      setTestResult(data);
    } catch {
      setTestResult({ ok: false, outcome: "network_error", message: "请求失败" });
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    if (isCreating && !testResult?.ok) {
      setError(t("settings.stockApi.testRequired"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: form.name.trim(),
        market: form.market,
        parser: form.parser,
        parserConfig: buildParserConfig(form),
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey.trim(),
        priority: form.priority,
        isActive: form.isActive,
      };
      const res = await fetch("/api/v1/settings/stock-quote-api", {
        method: isCreating ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isCreating ? payload : { ...payload, id: editingId }),
      });
      const data = await res.json();
      if (!data?.ok) {
        setError(data?.error ?? "保存失败");
        return;
      }
      closeModal();
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function toggle(api: StockQuoteApiRecord) {
    await fetch("/api/v1/settings/stock-quote-api", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: api.id, isActive: !api.isActive }),
    });
    await load();
  }

  async function remove(api: StockQuoteApiRecord) {
    const confirmed = await showConfirmDialog({
      title: t("settings.stockApi.deleteConfirm"),
      message: api.name,
      confirmLabel: t("common.delete"),
      cancelLabel: t("common.cancel"),
      tone: "danger",
    });
    if (!confirmed) return;
    const res = await fetch(`/api/v1/settings/stock-quote-api?id=${encodeURIComponent(api.id)}`, {
      method: "DELETE",
    });
    const data = await res.json();
    if (!data?.ok) setError(data?.error ?? "删除失败");
    await load();
  }

  function parserLabel(api: StockQuoteApiRecord): string {
    const parser = parserOf(api);
    if (parser === "eastmoney_kline") return t("settings.stockApi.parserEastmoney");
    if (parser === "tencent_kline") return t("settings.stockApi.parserTencent");
    return t("settings.stockApi.parserJson");
  }

  return (
    <div className="space-y-3">
      <SettingsPageHeader
        title={t("settings.stockApi.listTitle")}
        count={apis.length}
        actions={<SettingsPrimaryAddButton onClick={openCreate}>{t("settings.stockApi.add")}</SettingsPrimaryAddButton>}
      />

      {error ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</div>
      ) : null}

      <SettingsSection title={t("settings.stockApi.listTitle")} count={apis.length}>
        <SettingsTable minWidth={820}>
          <thead>
            <tr>
              <SettingsTh>{t("settings.stockApi.name")}</SettingsTh>
              <SettingsTh>{t("settings.stockApi.market")}</SettingsTh>
              <SettingsTh>{t("settings.stockApi.parser")}</SettingsTh>
              <SettingsTh>{t("settings.stockApi.baseUrl")}</SettingsTh>
              <SettingsTh align="center">{t("settings.stockApi.enabled")}</SettingsTh>
              <SettingsTh align="right">{""}</SettingsTh>
            </tr>
          </thead>
          <tbody>
            {apis.length === 0 ? (
              <SettingsEmptyRow colSpan={6}>
                {loading ? t("common.loading") : t("settings.stockApi.empty")}
              </SettingsEmptyRow>
            ) : (
              apis.map((api) => (
                <tr key={api.id}>
                  <SettingsTd>
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-slate-800">{api.name}</span>
                      {api.builtin ? (
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
                          {t("settings.stockApi.builtin")}
                        </span>
                      ) : null}
                    </div>
                  </SettingsTd>
                  <SettingsTd>
                    {api.market === "CN"
                      ? t("settings.stockApi.marketCn")
                      : api.market === "HK"
                        ? t("settings.stockApi.marketHk")
                        : api.market === "US"
                          ? t("settings.stockApi.marketUs")
                          : api.market === "*"
                            ? t("settings.stockApi.marketAll")
                            : api.market}
                  </SettingsTd>
                  <SettingsTd>{parserLabel(api)}</SettingsTd>
                  <SettingsTd className="max-w-[320px] truncate" title={api.baseUrl}>
                    {api.baseUrl}
                  </SettingsTd>
                  <SettingsTd align="center">
                    <button type="button" onClick={() => void toggle(api)} className="text-slate-500 hover:text-slate-800">
                      {api.isActive ? <Power className="h-4 w-4" /> : <PowerOff className="h-4 w-4" />}
                    </button>
                  </SettingsTd>
                  <SettingsTd align="right">
                    <SettingsRowActions>
                      <SettingsActionButton label={t("common.edit")} variant="edit" onClick={() => openEdit(api)} />
                      {api.builtin ? null : (
                        <SettingsActionButton
                          label={t("common.delete")}
                          variant="delete"
                          onClick={() => void remove(api)}
                        />
                      )}
                    </SettingsRowActions>
                  </SettingsTd>
                </tr>
              ))
            )}
          </tbody>
        </SettingsTable>
      </SettingsSection>

      {editingId ? (
        <ModalLayer className="app-modal-backdrop">
          <div className="app-modal-panel max-w-2xl">
            <div className="modal-header shrink-0">
              <div className="text-sm font-semibold text-slate-800">{form.name || t("settings.stockApi.add")}</div>
              <button type="button" onClick={closeModal} className="secondary-button inline-flex h-8 w-8 items-center justify-center px-0">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="max-h-[70vh] space-y-3 overflow-y-auto p-5">
              <div className="grid grid-cols-2 gap-3">
                <Field label={t("settings.stockApi.name")}>
                  <input className={inputClass} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
                </Field>
                <Field label={t("settings.stockApi.market")}>
                  <select
                    className={inputClass}
                    value={form.market}
                    onChange={(e) => {
                      const nextMarket = e.target.value;
                      setForm((f) => ({ ...f, market: nextMarket }));
                      // 测试代码跟着市场换示例，用户自己填过的代码不动。
                      setTestCode((prev) =>
                        !prev.trim() || Object.values(MARKET_TEST_CODES).includes(prev.trim())
                          ? MARKET_TEST_CODES[nextMarket] ?? prev
                          : prev,
                      );
                    }}
                  >
                    <option value="CN">{t("settings.stockApi.marketCn")}</option>
                    <option value="HK">{t("settings.stockApi.marketHk")}</option>
                    <option value="US">{t("settings.stockApi.marketUs")}</option>
                    <option value="*">{t("settings.stockApi.marketAll")}</option>
                  </select>
                </Field>
              </div>

              <Field label={t("settings.stockApi.parser")}>
                <select
                  className={inputClass}
                  value={form.parser}
                  onChange={(e) => setForm((f) => ({ ...f, parser: e.target.value as ParserCode }))}
                >
                  {PARSER_CODES.map((code) => (
                    <option key={code} value={code}>
                      {code === "eastmoney_kline"
                        ? t("settings.stockApi.parserEastmoney")
                        : code === "tencent_kline"
                          ? t("settings.stockApi.parserTencent")
                          : t("settings.stockApi.parserJson")}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label={t("settings.stockApi.baseUrl")}>
                <textarea
                  className="min-h-[72px] w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-xs outline-none"
                  value={form.baseUrl}
                  onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
                />
                <div className="text-[11px] leading-4 text-slate-400">{t("settings.stockApi.placeholderHint")}</div>
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label={t("settings.stockApi.apiKey")}>
                  <input className={inputClass} value={form.apiKey} onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))} />
                </Field>
                <Field label={t("settings.stockApi.order")}>
                  <input
                    type="number"
                    className={inputClass}
                    value={form.priority}
                    onChange={(e) => setForm((f) => ({ ...f, priority: Number(e.target.value) || 0 }))}
                  />
                </Field>
              </div>

              {form.parser === "json" ? (
                <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <div className="grid grid-cols-2 gap-3">
                    <Field label={t("settings.stockApi.pricePath")}>
                      <input className={inputClass} value={form.pricePath} onChange={(e) => setForm((f) => ({ ...f, pricePath: e.target.value }))} />
                    </Field>
                    <Field label={t("settings.stockApi.datePath")}>
                      <input className={inputClass} value={form.datePath} onChange={(e) => setForm((f) => ({ ...f, datePath: e.target.value }))} />
                    </Field>
                  </div>
                  <Field label={t("settings.stockApi.seriesPath")}>
                    <input className={inputClass} value={form.seriesPath} onChange={(e) => setForm((f) => ({ ...f, seriesPath: e.target.value }))} />
                  </Field>
                  {form.seriesPath.trim() ? (
                    <div className="grid grid-cols-2 gap-3">
                      <Field label={t("settings.stockApi.seriesPricePath")}>
                        <input className={inputClass} value={form.seriesPricePath} onChange={(e) => setForm((f) => ({ ...f, seriesPricePath: e.target.value }))} />
                      </Field>
                      <Field label={t("settings.stockApi.seriesDatePath")}>
                        <input className={inputClass} value={form.seriesDatePath} onChange={(e) => setForm((f) => ({ ...f, seriesDatePath: e.target.value }))} />
                      </Field>
                    </div>
                  ) : null}
                  <div className="grid grid-cols-2 gap-3">
                    <Field label={t("settings.stockApi.authIn")}>
                      <select
                        className={inputClass}
                        value={form.authIn}
                        onChange={(e) => setForm((f) => ({ ...f, authIn: e.target.value as FormState["authIn"] }))}
                      >
                        <option value="none">{t("settings.stockApi.authNone")}</option>
                        <option value="header">Header</option>
                        <option value="query">Query</option>
                      </select>
                    </Field>
                    <Field label={t("settings.stockApi.authName")}>
                      <input className={inputClass} value={form.authName} onChange={(e) => setForm((f) => ({ ...f, authName: e.target.value }))} />
                    </Field>
                  </div>
                </div>
              ) : null}

              <div className="space-y-2 rounded-lg border border-blue-200 bg-blue-50 p-3">
                <div className="text-xs font-medium text-blue-900">{t("settings.stockApi.test")}</div>
                <div className="text-[11px] leading-4 text-blue-700">{t("settings.stockApi.testHint")}</div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label={t("settings.stockApi.testCode")}>
                    <input className={inputClass} value={testCode} onChange={(e) => setTestCode(e.target.value)} />
                  </Field>
                  <Field label={t("settings.stockApi.testDate")}>
                    <input type="date" className={inputClass} value={testDate} onChange={(e) => setTestDate(e.target.value)} />
                  </Field>
                </div>
                <button
                  type="button"
                  onClick={() => void runTest()}
                  disabled={testing}
                  className="secondary-button h-8 px-3 text-xs disabled:opacity-50"
                >
                  {testing ? t("settings.stockApi.testing") : t("settings.stockApi.test")}
                </button>

                {testResult ? (
                  <div className="space-y-1.5 rounded-md bg-white p-2.5 text-xs">
                    <div className={testResult.ok ? "text-emerald-700" : "text-rose-700"}>
                      {testResult.ok
                        ? t("settings.stockApi.testOk", {
                            code: testResult.stockCode ?? "",
                            date: testResult.priceDate ?? testResult.date ?? "",
                            price: String(testResult.closePrice ?? ""),
                          })
                        : t("settings.stockApi.testFailed", {
                            reason: testResult.message || testResult.outcome || "",
                          })}
                    </div>
                    {testResult.candidates?.length ? (
                      <div className="text-slate-500">
                        <span className="text-slate-400">{t("settings.stockApi.candidates")}: </span>
                        {testResult.candidates.map((item) => `${item.priceDate} ${item.closePrice}`).join(" · ")}
                      </div>
                    ) : null}
                    {testResult.raw ? (
                      <details>
                        <summary className="cursor-pointer text-slate-400">{t("settings.stockApi.raw")}</summary>
                        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all text-[10px] text-slate-500">
                          {testResult.raw}
                        </pre>
                      </details>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-slate-100 p-3">
              <button type="button" onClick={closeModal} className="secondary-button h-8 px-3 text-xs">
                {t("settings.stockApi.cancel")}
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving}
                className="primary-button h-8 px-3 text-xs disabled:opacity-50"
              >
                {t("settings.stockApi.save")}
              </button>
            </div>
          </div>
        </ModalLayer>
      ) : null}
    </div>
  );
}
