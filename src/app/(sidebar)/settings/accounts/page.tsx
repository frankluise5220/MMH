"use client";

import { useState, useEffect } from "react";
import { Plus, Trash2, Pencil, Check, X, Power, PowerOff, CreditCard, Wallet, Building2, Landmark, PiggyBank, Banknote } from "lucide-react";
import type { AccountKind } from "@prisma/client";

type Group = { id: string; name: string; sortOrder: number };
type Institution = { id: string; name: string };
type Account = {
  id: string; name: string; kind: AccountKind; currency: string; isActive: boolean;
  institutionId: string | null; groupId: string | null;
  Institution: { id: string; name: string } | null;
  AccountGroup: { id: string; name: string } | null;
  billingDay: number | null; repaymentDay: number | null;
  creditLimit: string | null; numberMasked: string | null;
  investProductType: string | null; costBasisMethod: string | null;
};

const kindIcon = (k: string) => {
  if (k === "bank_credit") return <CreditCard className="w-3.5 h-3.5" />;
  if (k === "bank_debit") return <Landmark className="w-3.5 h-3.5" />;
  if (k === "ewallet") return <Wallet className="w-3.5 h-3.5" />;
  if (k === "cash") return <Banknote className="w-3.5 h-3.5" />;
  if (k === "investment") return <PiggyBank className="w-3.5 h-3.5" />;
  return <Building2 className="w-3.5 h-3.5" />;
};

const kindLabel = (k: string) => {
  const m: Record<string, string> = { bank_credit: "信用卡", bank_debit: "借记卡", ewallet: "电子钱包", cash: "现金", investment: "投资", loan: "贷款", other: "其他", bank_savings: "储蓄卡" };
  return m[k] || k;
};

const kindColor = (k: string) => {
  if (k === "bank_credit") return "bg-amber-50 text-amber-700 border-amber-200";
  if (k === "bank_debit") return "bg-slate-50 text-slate-700 border-slate-200";
  if (k === "ewallet") return "bg-blue-50 text-blue-700 border-blue-200";
  if (k === "cash") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (k === "investment") return "bg-purple-50 text-purple-700 border-purple-200";
  if (k === "loan") return "bg-red-50 text-red-700 border-red-200";
  return "bg-slate-50 text-slate-700 border-slate-200";
};

export default function SettingsAccountsPage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [filterMode, setFilterMode] = useState<"group" | "institution">("group");
  const [selectedFilter, setSelectedFilter] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Record<string, string>>({});

  // Group CRUD
  const [newGroupName, setNewGroupName] = useState("");
  const [editGroupId, setEditGroupId] = useState<string | null>(null);
  const [editGroupName, setEditGroupName] = useState("");

  // Add account
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ name: "", kind: "bank_debit", institutionId: "", currency: "CNY" });

  useEffect(() => { loadAll(); }, []);

  async function loadAll() {
    const res = await fetch("/api/v1/accounts/internal").catch(() => null);
    if (!res) return;
    const data = await res.json();
    if (data.ok) {
      setGroups(data.groups || []);
      setAccounts(data.accounts || []);
      setInstitutions(data.institutions || []);
    }
  }

  // ---- Group handlers ----
  async function createGroup() {
    if (!newGroupName.trim()) return;
    await fetch("/api/v1/account-group", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newGroupName.trim() }),
    });
    setNewGroupName("");
    loadAll();
  }

  async function updateGroup() {
    if (!editGroupId || !editGroupName.trim()) return;
    await fetch("/api/v1/account-group", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: editGroupId, name: editGroupName.trim() }),
    });
    setEditGroupId(null);
    loadAll();
  }

  async function deleteGroup(id: string) {
    const res = await fetch("/api/v1/settings/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entity: "accountGroup", id }),
    });
    const data = await res.json();
    if (data.ok) { setSelectedFilter(null); loadAll(); }
    else window.alert(data.error);
  }

  // ---- Account handlers ----
  function openEdit(a: Account) {
    setEditingId(a.id);
    setEditForm({
      name: a.name,
      groupId: a.groupId || "",
      institutionId: a.institutionId || "",
      billingDay: a.billingDay?.toString() || "",
      repaymentDay: a.repaymentDay?.toString() || "",
      creditLimit: a.creditLimit || "",
      numberMasked: a.numberMasked || "",
    });
  }

  async function saveEdit() {
    if (!editingId) return;
    await fetch("/api/v1/accounts", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: editingId, ...editForm }),
    });
    setEditingId(null);
    loadAll();
  }

  async function toggleActive(id: string) {
    await fetch("/api/v1/accounts", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    loadAll();
  }

  async function createAccount() {
    if (!addForm.name.trim()) return;
    const payload: Record<string, string | undefined> = { ...addForm };
    if (filterMode === "group" && selectedFilter) payload.groupId = selectedFilter;
    if (filterMode === "institution" && addForm.institutionId) payload.institutionId = addForm.institutionId;
    await fetch("/api/v1/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setAddForm({ name: "", kind: "bank_debit", institutionId: "", currency: "CNY" });
    setShowAdd(false);
    loadAll();
  }

  const filteredAccounts = filterMode === "group" && selectedFilter
    ? accounts.filter(a => a.groupId === selectedFilter)
    : filterMode === "institution" && selectedFilter
      ? accounts.filter(a => a.institutionId === selectedFilter)
      : accounts;

  // Stats for the filter sidebar
  const institutionAccountCounts = new Map<string, number>();
  for (const a of accounts) {
    if (a.institutionId) institutionAccountCounts.set(a.institutionId, (institutionAccountCounts.get(a.institutionId) || 0) + 1);
  }
  // Also count accounts without institution
  const noInstitutionCount = accounts.filter(a => !a.institutionId).length;

  // Group accounts by kind for display
  const grouped = new Map<string, Account[]>();
  for (const a of filteredAccounts) {
    const list = grouped.get(a.kind) || [];
    list.push(a);
    grouped.set(a.kind, list);
  }
  const kindOrder = ["bank_credit", "bank_debit", "bank_savings", "ewallet", "cash", "investment", "loan", "other"];

  return (
    <div className="flex min-h-0">
      {/* ===== 左侧：筛选边栏 ===== */}
      <div className="w-52 shrink-0 border-r border-slate-200 bg-white flex flex-col">
        <div className="px-4 py-3 border-b border-slate-100 shrink-0">
          <div className="text-sm font-semibold text-slate-800">筛选</div>
        </div>

        {/* 分组 / 机构 切换 */}
        <div className="px-3 py-2 border-b border-slate-50 flex gap-1">
          <button onClick={() => { setFilterMode("group"); setSelectedFilter(null); }}
            className={`flex-1 h-7 rounded text-xs font-medium transition-colors ${filterMode === "group" ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>
            分组
          </button>
          <button onClick={() => { setFilterMode("institution"); setSelectedFilter(null); }}
            className={`flex-1 h-7 rounded text-xs font-medium transition-colors ${filterMode === "institution" ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>
            机构
          </button>
        </div>

        {/* 分组模式 */}
        {filterMode === "group" && (
          <>
            <div className="px-3 py-2 border-b border-slate-50">
              <div className="flex gap-1">
                <input value={newGroupName} onChange={e => setNewGroupName(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && createGroup()}
                  className="flex-1 h-7 rounded border border-slate-200 px-2 text-xs outline-none focus:border-blue-400"
                  placeholder="新建分组…" />
                <button onClick={createGroup} disabled={!newGroupName.trim()}
                  className="h-7 w-7 flex items-center justify-center rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 shrink-0">
                  <Plus className="w-3 h-3" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto py-1">
              <button onClick={() => setSelectedFilter(null)}
                className={`w-full text-left px-3 py-1.5 text-sm ${!selectedFilter ? "bg-blue-50 text-blue-700 font-medium" : "text-slate-600 hover:bg-slate-50"}`}>
                全部 ({accounts.length})
              </button>
              {groups.map(g => (
                <div key={g.id} className="group">
                  {editGroupId === g.id ? (
                    <div className="flex items-center gap-1 px-3 py-1">
                      <input value={editGroupName} onChange={e => setEditGroupName(e.target.value)}
                        onKeyDown={e => e.key === "Enter" && updateGroup()}
                        className="flex-1 h-7 rounded border border-blue-300 px-2 text-xs outline-none" autoFocus />
                      <button onClick={updateGroup} className="h-6 w-6 flex items-center justify-center rounded text-emerald-600 hover:bg-emerald-50"><Check className="w-3 h-3" /></button>
                      <button onClick={() => setEditGroupId(null)} className="h-6 w-6 flex items-center justify-center rounded text-slate-400 hover:bg-slate-100"><X className="w-3 h-3" /></button>
                    </div>
                  ) : (
                    <button onClick={() => setSelectedFilter(g.id)}
                      className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-1 ${selectedFilter === g.id ? "bg-blue-50 text-blue-700 font-medium" : "text-slate-600 hover:bg-slate-50"}`}>
                      <span className="flex-1 truncate">{g.name}</span>
                      <span className="text-[10px] text-slate-400">{accounts.filter(a => a.groupId === g.id).length}</span>
                      <button onClick={e => { e.stopPropagation(); setEditGroupId(g.id); setEditGroupName(g.name); }}
                        className="h-5 w-5 hidden group-hover:flex items-center justify-center rounded text-slate-400 hover:text-blue-600 shrink-0">
                        <Pencil className="w-3 h-3" />
                      </button>
                      <button onClick={e => { e.stopPropagation(); if (confirm("删除分组？")) deleteGroup(g.id); }}
                        className="h-5 w-5 hidden group-hover:flex items-center justify-center rounded text-slate-400 hover:text-red-500 shrink-0">
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        {/* 机构模式 */}
        {filterMode === "institution" && (
          <div className="flex-1 overflow-y-auto py-1">
            <button onClick={() => setSelectedFilter(null)}
              className={`w-full text-left px-3 py-1.5 text-sm ${!selectedFilter ? "bg-blue-50 text-blue-700 font-medium" : "text-slate-600 hover:bg-slate-50"}`}>
              全部 ({accounts.length})
            </button>
            {institutions.map(i => (
              <button key={i.id}
                onClick={() => setSelectedFilter(i.id)}
                className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-1 ${selectedFilter === i.id ? "bg-blue-50 text-blue-700 font-medium" : "text-slate-600 hover:bg-slate-50"}`}>
                <Building2 className="w-3 h-3 text-slate-400 shrink-0" />
                <span className="flex-1 truncate">{i.name}</span>
                <span className="text-[10px] text-slate-400">{institutionAccountCounts.get(i.id) || 0}</span>
              </button>
            ))}
            {noInstitutionCount > 0 && (
              <div className="px-3 py-2 text-xs text-slate-400">
                未关联机构：{noInstitutionCount} 个
              </div>
            )}
          </div>
        )}
      </div>

     
{/* ===== 右侧：账户列表 ===== */}
      <div className="flex-1 bg-slate-50 p-5 min-w-0 overflow-y-auto" style={{ height: "calc(100vh - 8.5rem)" }}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-800">
              {selectedFilter
                ? (filterMode === "group"
                    ? groups.find(g => g.id === selectedFilter)?.name
                    : institutions.find(i => i.id === selectedFilter)?.name) + " 的账户"
                : "所有账户"}
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">共 {filteredAccounts.length} 个账户</p>
          </div>
          <button onClick={() => setShowAdd(!showAdd)}
            className="h-8 px-3 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 flex items-center gap-1">
            <Plus className="w-3.5 h-3.5" />新增
          </button>
        </div>

        {/* Add account form */}
        {showAdd && (
          <div className="bg-white border border-blue-200 rounded-xl p-4 mb-4">
            <div className="text-sm font-medium text-slate-700 mb-3">新增账户</div>
            <div className="grid grid-cols-4 gap-3">
              <div>
                <label className="block text-xs text-slate-500 mb-1">名称</label>
                <input value={addForm.name} onChange={e => setAddForm(f => ({ ...f, name: e.target.value }))}
                  className="h-9 w-full rounded-md border border-slate-200 px-3 text-sm outline-none focus:border-blue-400" placeholder="账户名称" />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">类型</label>
                <select value={addForm.kind} onChange={e => setAddForm(f => ({ ...f, kind: e.target.value }))}
                  className="h-9 w-full rounded-md border border-slate-200 px-3 text-sm outline-none">
                  {kindOrder.map(k => <option key={k} value={k}>{kindLabel(k)}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">机构</label>
                <select value={addForm.institutionId} onChange={e => setAddForm(f => ({ ...f, institutionId: e.target.value }))}
                  className="h-9 w-full rounded-md border border-slate-200 px-3 text-sm outline-none">
                  <option value="">无</option>
                  {institutions.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
                </select>
              </div>
              <div className="flex items-end gap-2">
                <button onClick={createAccount} disabled={!addForm.name.trim()}
                  className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50">创建</button>
                <button onClick={() => setShowAdd(false)}
                  className="h-9 px-3 rounded-md border border-slate-200 bg-white text-sm text-slate-600 hover:bg-slate-50">取消</button>
              </div>
            </div>
          </div>
        )}

        {/* Account cards grouped by kind */}
        <div className="space-y-5">
          {kindOrder.map(kind => {
            const list = grouped.get(kind);
            if (!list || list.length === 0) return null;
            return (
              <div key={kind}>
                <div className="flex items-center gap-2 mb-2">
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded border ${kindColor(kind)}`}>
                    {kindIcon(kind)} {kindLabel(kind)}
                  </span>
                  <span className="text-[10px] text-slate-400">{list.length} 个</span>
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
                  {list.map(a => (
                    <div key={a.id}
                      className={`border rounded-lg bg-white transition-colors ${!a.isActive ? "opacity-60 bg-slate-50" : ""} ${editingId === a.id ? "border-blue-300 ring-1 ring-blue-100" : "border-slate-200"}`}>
                      {editingId === a.id ? (
                        /* ---- Edit mode ---- */
                        <div className="p-4 space-y-3">
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <label className="block text-xs text-slate-500 mb-1">名称</label>
                              <input value={editForm.name || ""} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
                                className="h-8 w-full rounded border border-slate-200 px-2 text-sm outline-none focus:border-blue-400" />
                            </div>
                            <div>
                              <label className="block text-xs text-slate-500 mb-1">分组</label>
                              <select value={editForm.groupId || ""} onChange={e => setEditForm(f => ({ ...f, groupId: e.target.value }))}
                                className="h-8 w-full rounded border border-slate-200 px-2 text-sm outline-none">
                                <option value="">未分组</option>
                                {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                              </select>
                            </div>
                          </div>

                          {(a.kind === "bank_credit" || a.kind === "loan") && (
                            <div className="grid grid-cols-4 gap-3">
                              <div>
                                <label className="block text-xs text-slate-500 mb-1">账单日</label>
                                <input value={editForm.billingDay || ""} onChange={e => setEditForm(f => ({ ...f, billingDay: e.target.value }))}
                                  className="h-8 w-full rounded border border-slate-200 px-2 text-sm outline-none" placeholder="1-31" />
                              </div>
                              <div>
                                <label className="block text-xs text-slate-500 mb-1">还款日</label>
                                <input value={editForm.repaymentDay || ""} onChange={e => setEditForm(f => ({ ...f, repaymentDay: e.target.value }))}
                                  className="h-8 w-full rounded border border-slate-200 px-2 text-sm outline-none" placeholder="1-31" />
                              </div>
                              <div>
                                <label className="block text-xs text-slate-500 mb-1">额度</label>
                                <input value={editForm.creditLimit || ""} onChange={e => setEditForm(f => ({ ...f, creditLimit: e.target.value }))}
                                  className="h-8 w-full rounded border border-slate-200 px-2 text-sm outline-none" />
                              </div>
                              <div>
                                <label className="block text-xs text-slate-500 mb-1">卡号后四位</label>
                                <input value={editForm.numberMasked || ""} onChange={e => setEditForm(f => ({ ...f, numberMasked: e.target.value }))}
                                  className="h-8 w-full rounded border border-slate-200 px-2 text-sm outline-none" />
                              </div>
                            </div>
                          )}

                          <div className="flex justify-end gap-2 pt-1">
                            <button onClick={() => setEditingId(null)}
                              className="h-7 px-3 rounded border border-slate-200 bg-white text-xs text-slate-600 hover:bg-slate-50">取消</button>
                            <button onClick={saveEdit}
                              className="h-7 px-3 rounded bg-blue-600 text-white text-xs hover:bg-blue-700">保存</button>
                          </div>
                        </div>
                      ) : (
                        /* ---- View mode ---- */
                        <div className="p-3 flex items-center justify-between">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-slate-800 truncate">{a.name}</span>
                              <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${a.isActive ? "bg-emerald-50 text-emerald-600 border-emerald-200" : "bg-slate-100 text-slate-400 border-slate-200"}`}>
                                {a.isActive ? "启用" : "停用"}
                              </span>
                            </div>
                            <div className="flex items-center gap-2 mt-0.5 text-xs text-slate-400">
                              {a.AccountGroup && <span>{a.AccountGroup.name}</span>}
                              {a.Institution && <span>{a.Institution.name}</span>}
                              {(a.billingDay) && <span>账单日{a.billingDay}日</span>}
                              {(a.repaymentDay) && <span>还款{a.repaymentDay}日</span>}
                              {a.creditLimit && <span>额度￥{a.creditLimit}</span>}
                              {a.numberMasked && <span>尾号{a.numberMasked}</span>}
                            </div>
                          </div>
                          <div className="flex items-center gap-1 shrink-0 ml-3">
                            <button onClick={() => toggleActive(a.id)}
                              className="h-7 w-7 flex items-center justify-center rounded-md border border-slate-200 bg-white hover:bg-slate-50"
                              title={a.isActive ? "停用" : "启用"}>
                              {a.isActive ? <PowerOff className="w-3 h-3 text-slate-400" /> : <Power className="w-3 h-3 text-amber-500" />}
                            </button>
                            <button onClick={() => openEdit(a)}
                              className="h-7 w-7 flex items-center justify-center rounded-md border border-slate-200 bg-white hover:bg-slate-50"
                              title="编辑">
                              <Pencil className="w-3 h-3 text-slate-400" />
                            </button>
                            <button onClick={async () => {
                              if (!confirm(`删除账户「${a.name}」？`)) return;
                              const res = await fetch(`/api/v1/accounts?id=${a.id}`, { method: "DELETE" });
                              const data = await res.json();
                              if (data.ok) loadAll(); else window.alert(data.error);
                            }}
                              className="h-7 w-7 flex items-center justify-center rounded-md border border-slate-200 bg-white hover:bg-red-50"
                              title="删除">
                              <Trash2 className="w-3 h-3 text-slate-400 hover:text-red-500" />
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}

          {filteredAccounts.length === 0 && (
            <div className="text-sm text-slate-400 text-center py-12">
              暂无账户。点击右上角"新增"按钮添加。
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
