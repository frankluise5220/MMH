"use client";

import { useEffect, useMemo, useState } from "react";

type ListItem = { uid: number; subject: string; from: string; date: string };
type ParsedItem = {
  rawText: string;
  type: "expense" | "income" | "transfer" | "investment";
  date?: string;
  amount: number;
  account?: string;
  fromAccount?: string;
  toAccount?: string;
  category?: string;
  remark?: string;
  counterparty?: string;
};

type ImportSummary = {
  parsedCount: number;
  createdCount: number;
  skippedCount: number;
  errors: Array<{ index: number; rawText: string; error: string }>;
};

function htmlToReadableText(html: string) {
  if (!html.trim()) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "\n")
    .replace(/<script[\s\S]*?<\/script>/gi, "\n")
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/table|\/h\d)>/gi, "\n")
    .replace(/<\/t[dh]>/gi, "\t")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\r/g, "")
    .replace(/\t+/g, "\t")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

export default function SettingsEmailPage() {
  const [host, setHost] = useState("");
  const [port, setPort] = useState("993");
  const [secure, setSecure] = useState(true);
  const [mailbox, setMailbox] = useState("INBOX");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [limit, setLimit] = useState("20");
  const [subjectIncludes, setSubjectIncludes] = useState("");
  const [fromIncludes, setFromIncludes] = useState("");

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [discoveringMailboxes, setDiscoveringMailboxes] = useState(false);
  const [loading, setLoading] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [importing, setImporting] = useState(false);

  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [debugTrace, setDebugTrace] = useState<string[]>([]);
  const [discoveredMailboxes, setDiscoveredMailboxes] = useState<string[]>([]);
  const [items, setItems] = useState<ListItem[]>([]);
  const [selectedUid, setSelectedUid] = useState<number | null>(null);
  const [selectedSubject, setSelectedSubject] = useState("");
  const [selectedFrom, setSelectedFrom] = useState("");
  const [selectedDate, setSelectedDate] = useState("");
  const [content, setContent] = useState("");

  const [reviseInstruction, setReviseInstruction] = useState("");
  const [parsedItems, setParsedItems] = useState<ParsedItem[]>([]);
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);

  useEffect(() => {
    fetch("/api/v1/settings/email")
      .then((r) => r.json())
      .then((d) => {
        if (d.ok && d.data) {
          setHost(d.data.emailHost ?? "");
          setPort(String(d.data.emailPort ?? "993"));
          setSecure(d.data.emailSecure !== false);
          setMailbox(d.data.emailMailbox ?? "INBOX");
          setUser(d.data.emailUser ?? "");
          setPassword(d.data.emailPassword ?? "");
        }
      })
      .catch(() => {});
  }, []);

  const canQuery = useMemo(() => host.trim() && user.trim() && password.trim(), [host, user, password]);

  async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs = 10000) {
    const controller = new AbortController();
    const startedAt = Date.now();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(input, { ...init, signal: controller.signal });
      return { response, elapsedMs: Date.now() - startedAt };
    } finally {
      clearTimeout(timer);
    }
  }

  async function onSave() {
    if (saving || testing || loading || parsing || importing) return;
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/v1/settings/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          emailHost: host.trim(),
          emailPort: Number(port) || 993,
          emailSecure: secure,
          emailUser: user.trim(),
          emailPassword: password,
          emailMailbox: mailbox.trim() || "INBOX",
        }),
      });
      const data = (await res.json().catch(() => null)) as { ok: true } | { ok: false; error: string } | null;
      if (!data || data.ok !== true) throw new Error((data as { error?: string })?.error ?? "保存失败");
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function onDiscoverMailboxes() {
    if (discoveringMailboxes || testing || loading || parsing || importing) return;
    if (!canQuery) {
      setError("请先填写 IMAP 主机、邮箱账号和授权码/密码。");
      return;
    }
    setDiscoveringMailboxes(true);
    setError("");
    setInfo("正在探测邮箱目录，请稍候…");
    setDebugTrace([]);
    setDiscoveredMailboxes([]);
    try {
      const { response: res } = await fetchWithTimeout("/api/v1/email/imap/mailboxes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host: host.trim(),
          port: Number(port) || 993,
          secure,
          user: user.trim(),
          password,
        }),
      }, 30000);
      const data = (await res.json().catch(() => null)) as
        | { ok: true; trace?: string[]; mailboxes?: string[] }
        | { ok: false; error: string; trace?: string[] }
        | null;
      if (!data) throw new Error("探测邮箱目录失败");
      setDebugTrace(data.trace ?? []);
      if (data.ok !== true) throw new Error(data.error ?? "探测邮箱目录失败");
      setDiscoveredMailboxes(data.mailboxes ?? []);
      setInfo(`目录探测完成，发现 ${(data.mailboxes ?? []).length} 个目录。`);
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        setError("探测目录超时（30秒）。请检查网络与邮箱IMAP配置。");
      } else {
        setError(e instanceof Error ? e.message : "探测邮箱目录失败");
      }
      setInfo("");
    } finally {
      setDiscoveringMailboxes(false);
    }
  }

  async function onTestConnection() {
    if (!canQuery || testing || loading || parsing || importing) return;
    setTesting(true);
    setError("");
    setDebugTrace([]);
    try {
      const { response: res } = await fetchWithTimeout("/api/v1/email/imap/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host: host.trim(),
          port: Number(port) || 993,
          secure,
          user: user.trim(),
          password,
          mailbox: mailbox.trim() || "INBOX",
        }),
      }, 30000);
      const data = (await res.json().catch(() => null)) as
        | { ok: true; trace?: string[] }
        | { ok: false; error: string; trace?: string[] }
        | null;
      if (!data) throw new Error("连接测试失败");
      setDebugTrace(data.trace ?? []);
      if (data.ok !== true) throw new Error(data.error ?? "连接测试失败");
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        setError("连接测试超时（30秒）。请检查网络与邮箱IMAP配置。");
      } else {
        setError(e instanceof Error ? e.message : "连接测试失败");
      }
    } finally {
      setTesting(false);
    }
  }

  async function onList() {
    if (!canQuery || loading || parsing || importing) return;
    setLoading(true);
    setError("");
    setItems([]);
    setSelectedUid(null);
    setSelectedSubject("");
    setSelectedFrom("");
    setSelectedDate("");
    setContent("");
    setReviseInstruction("");
    setParsedItems([]);
    setImportSummary(null);
    setDebugTrace([]);
    try {
      const { response: res } = await fetchWithTimeout("/api/v1/email/imap/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host: host.trim(),
          port: Number(port) || 993,
          secure,
          user: user.trim(),
          password,
          mailbox: mailbox.trim() || "INBOX",
          limit: Number(limit) || 20,
          subjectIncludes: subjectIncludes.trim() || undefined,
          fromIncludes: fromIncludes.trim() || undefined,
          debug: true,
        }),
      }, 45000);
      const data = (await res.json().catch(() => null)) as
        | { ok: true; items: ListItem[]; trace?: string[] }
        | { ok: false; error: string; trace?: string[] }
        | null;
      if (!data) throw new Error("读取失败");
      setDebugTrace(data.trace ?? []);
      if (data.ok !== true) throw new Error(data.error ?? "读取失败");
      setItems(data.items ?? []);
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        setError("读取超时（45秒）。连接测试已通过，通常是邮箱列表较大，请稍后重试或先把拉取条数调小。");
      } else {
        setError(e instanceof Error ? e.message : "读取失败");
      }
    } finally {
      setLoading(false);
    }
  }

  async function onFetch(uid: number) {
    if (!canQuery || loading || parsing || importing) return;
    setLoading(true);
    setError("");
    setSelectedUid(uid);
    setContent("");
    setReviseInstruction("");
    setParsedItems([]);
    setImportSummary(null);
    try {
      const { response: res } = await fetchWithTimeout("/api/v1/email/imap/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host: host.trim(),
          port: Number(port) || 993,
          secure,
          user: user.trim(),
          password,
          mailbox: mailbox.trim() || "INBOX",
          uid,
          debug: true,
        }),
      }, 45000);
      const data = (await res.json().catch(() => null)) as
        | { ok: true; item: { uid: number; subject: string; from: string; date: string; text: string; html: string } }
        | { ok: false; error: string }
        | null;
      if (!data || data.ok !== true) throw new Error((data as { error?: string })?.error ?? "读取失败");

      const text = (data.item.text ?? "").trim();
      const html = (data.item.html ?? "").trim();
      setContent(text || htmlToReadableText(html));
      setSelectedSubject(data.item.subject ?? "");
      setSelectedFrom(data.item.from ?? "");
      setSelectedDate(data.item.date ?? "");
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        setError("读取邮件超时（45秒）。请先确认列表可读，再重试选择邮件。");
      } else {
        setError(e instanceof Error ? e.message : "读取失败");
      }
      setSelectedUid(null);
      setSelectedSubject("");
      setSelectedFrom("");
      setSelectedDate("");
      setContent("");
    } finally {
      setLoading(false);
    }
  }

  async function onParse() {
    if (!content.trim() || parsing || importing) return;
    setParsing(true);
    setError("");
    setImportSummary(null);
    try {
      const parseRes = await fetch("/api/v1/statement/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: content, reviseInstruction: reviseInstruction.trim() || undefined }),
      });
      const parseData = (await parseRes.json().catch(() => null)) as
        | { ok: true; items: ParsedItem[] }
        | { ok: false; error: string }
        | null;
      if (!parseData || parseData.ok !== true) throw new Error((parseData as { error?: string })?.error ?? "识别失败");

      const rows = (parseData.items ?? []).filter((x) => Number.isFinite(x.amount) && Math.abs(x.amount) > 0);
      setParsedItems(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : "识别失败");
    } finally {
      setParsing(false);
    }
  }

  async function onImport() {
    if (!parsedItems.length || importing || parsing) return;
    setImporting(true);
    setError("");
    try {
      const importRes = await fetch("/api/v1/statement/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: parsedItems }),
      });
      const importData = (await importRes.json().catch(() => null)) as
        | { ok: true; createdCount: number; skippedCount?: number; errors?: Array<{ index: number; rawText: string; error: string }> }
        | { ok: false; error: string }
        | null;
      if (!importData || importData.ok !== true) throw new Error((importData as { error?: string })?.error ?? "导入失败");

      setImportSummary({
        parsedCount: parsedItems.length,
        createdCount: importData.createdCount ?? 0,
        skippedCount: importData.skippedCount ?? 0,
        errors: importData.errors ?? [],
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "导入失败");
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200">
          <div className="text-sm font-semibold text-slate-800">IMAP 登录并读取账单邮件</div>
          <div className="mt-1 text-xs text-slate-500">建议使用邮箱的“授权码/客户端专用密码”，不要使用网页登录密码。</div>
        </div>
        <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-3">
          <input className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={host} onChange={(e) => setHost(e.target.value)} placeholder="IMAP Host，例如：imap.sohu.com" />
          <div className="grid grid-cols-2 gap-2">
            <input className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={port} onChange={(e) => setPort(e.target.value)} placeholder="端口，例如：993" inputMode="numeric" />
            <label className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700 flex items-center gap-2">
              <input type="checkbox" checked={secure} onChange={(e) => setSecure(e.target.checked)} />TLS
            </label>
          </div>
          <input className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={user} onChange={(e) => setUser(e.target.value)} placeholder="邮箱账号" autoComplete="username" />
          <input className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="授权码/客户端密码" type="password" autoComplete="current-password" />
          <input className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={mailbox} onChange={(e) => setMailbox(e.target.value)} placeholder="邮箱文件夹，例如：INBOX" />
          <div className="col-span-1 md:col-span-2 flex items-center gap-2">
            <button className="h-9 px-3 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50" onClick={onSave} disabled={saving || loading || parsing || importing} type="button">
              {saving ? "保存中…" : "保存"}
            </button>
            <button className="h-9 px-3 rounded-md border border-slate-300 text-sm hover:bg-slate-50 disabled:opacity-50" onClick={onTestConnection} disabled={testing || discoveringMailboxes || saving || loading || parsing || importing} type="button">
              {testing ? "连接测试中…" : "连接测试"}
            </button>
            <button className="h-9 px-3 rounded-md border border-slate-300 text-sm hover:bg-slate-50 disabled:opacity-50" onClick={onDiscoverMailboxes} disabled={discoveringMailboxes || testing || saving || loading || parsing || importing} type="button">
              {discoveringMailboxes ? "探测目录中…" : "探测邮箱目录"}
            </button>
          </div>
        </div>
      </div>

      {error && <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}
      {info && <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-700">{info}</div>}
      {debugTrace.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 space-y-1">
          {debugTrace.map((line, idx) => (
            <div key={idx}>{line}</div>
          ))}
        </div>
      )}
      {discoveredMailboxes.length > 0 && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2">
          <div className="text-xs font-medium text-emerald-800 mb-1">探测到的邮箱目录</div>
          <div className="max-h-36 overflow-auto space-y-1">
            {discoveredMailboxes.map((mb, idx) => (
              <button
                key={`${mb}-${idx}`}
                type="button"
                className="block w-full text-left rounded px-2 py-1 text-xs text-emerald-900 hover:bg-emerald-100"
                onClick={() => setMailbox(mb)}
                title="点击使用该目录"
              >
                {mb}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
            <div className="text-sm font-semibold text-slate-800">邮件列表</div>
          </div>
          <div className="p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <input className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="拉取条数，例如：20" inputMode="numeric" />
              <input className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={subjectIncludes} onChange={(e) => setSubjectIncludes(e.target.value)} placeholder="主题关键词（可选）" />
              <input className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={fromIncludes} onChange={(e) => setFromIncludes(e.target.value)} placeholder="发件人关键词（可选）" />
              <button className="h-9 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50 col-span-2" onClick={onList} disabled={!canQuery || loading || parsing || importing} type="button">
                {loading ? "读取中…" : "读取列表"}
              </button>
            </div>

            <div className="min-h-40 max-h-[620px] overflow-auto rounded-md border border-slate-200 divide-y divide-slate-100">
              {!items.length && !loading ? (
                <div className="px-3 py-6 text-sm text-slate-500">暂无邮件，请点击“读取列表”加载。</div>
              ) : null}
              {loading && !items.length ? (
                <div className="px-3 py-6 text-sm text-slate-500">正在读取邮件列表…</div>
              ) : null}
              {items.map((item) => (
                <button
                  key={item.uid}
                  className={`w-full text-left px-3 py-2 text-sm ${selectedUid === item.uid ? "bg-blue-50" : "bg-white hover:bg-slate-50"}`}
                  onClick={() => onFetch(item.uid)}
                  type="button"
                >
                  <div className="font-medium text-slate-800 truncate">{item.subject || "（无主题）"}</div>
                  <div className="text-xs text-slate-500">{item.from} · {item.date}</div>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-slate-800">邮件内容</div>
              <div className="text-xs text-slate-500 truncate">
                {selectedSubject || "未选择邮件"}
                {selectedFrom ? ` · ${selectedFrom}` : ""}
                {selectedDate ? ` · ${selectedDate}` : ""}
              </div>
            </div>
            <button className="h-9 px-3 rounded-md bg-indigo-600 text-white text-sm hover:bg-indigo-700 disabled:opacity-50" type="button" onClick={onParse} disabled={!content.trim() || loading || parsing || importing}>
              {parsing ? "识别中…" : "AI识别预览"}
            </button>
          </div>
          <div className="p-4 space-y-3">
            <textarea
              className="w-full min-h-20 rounded-md border border-slate-200 px-3 py-2 text-sm outline-none"
              value={reviseInstruction}
              onChange={(e) => setReviseInstruction(e.target.value)}
              placeholder="如果识别有误，在这里输入修正指令，例如：把‘招商信用卡’统一为‘招行卡’，并把‘餐饮消费’归类到‘餐饮’"
            />
            <pre className="whitespace-pre-wrap text-sm text-slate-700 font-mono min-h-40 max-h-[320px] overflow-auto border border-slate-200 rounded-md p-3">{content || "请先在左侧邮件列表中选中一封邮件，这里会显示正文内容。"}</pre>
          </div>

          {parsedItems.length > 0 && (
            <div className="px-4 pb-4 space-y-2">
              <div className="text-sm font-semibold text-slate-800">识别预览（{parsedItems.length} 条）</div>
              <div className="max-h-72 overflow-auto rounded-md border border-slate-200">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 sticky top-0">
                    <tr>
                      <th className="text-left px-2 py-1">类型</th>
                      <th className="text-left px-2 py-1">日期</th>
                      <th className="text-right px-2 py-1">金额</th>
                      <th className="text-left px-2 py-1">账户</th>
                      <th className="text-left px-2 py-1">分类</th>
                      <th className="text-left px-2 py-1">摘要</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsedItems.map((row, idx) => (
                      <tr key={idx} className="border-t border-slate-100">
                        <td className="px-2 py-1">{row.type}</td>
                        <td className="px-2 py-1">{row.date || ""}</td>
                        <td className="px-2 py-1 text-right">{row.amount}</td>
                        <td className="px-2 py-1">{row.account || `${row.fromAccount || ""}${row.toAccount ? `→${row.toAccount}` : ""}`}</td>
                        <td className="px-2 py-1">{row.category || ""}</td>
                        <td className="px-2 py-1">{row.rawText}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex gap-2">
                <button className="h-9 px-3 rounded-md border border-slate-300 text-sm hover:bg-slate-50" onClick={onParse} disabled={parsing || importing} type="button">
                  {parsing ? "修正中…" : "按修正指令重新识别"}
                </button>
                <button className="h-9 px-3 rounded-md bg-emerald-600 text-white text-sm hover:bg-emerald-700 disabled:opacity-50" onClick={onImport} disabled={!parsedItems.length || parsing || importing} type="button">
                  {importing ? "导入中…" : "确认无误，导入系统"}
                </button>
              </div>
            </div>
          )}

          {importSummary && (
            <div className="px-4 pb-4">
              <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                识别 {importSummary.parsedCount} 条，导入成功 {importSummary.createdCount} 条，跳过 {importSummary.skippedCount} 条。
              </div>
              {importSummary.errors.length > 0 && (
                <div className="mt-2 max-h-36 overflow-auto rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 space-y-1">
                  {importSummary.errors.map((err, idx) => (
                    <div key={`${err.index}-${idx}`}>#{err.index + 1} {err.error}：{err.rawText}</div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
