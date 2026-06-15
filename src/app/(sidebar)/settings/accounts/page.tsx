"use client";

import { useState, useEffect } from "react";
import { Plus, Trash2, Pencil, Check, X, Power, PowerOff, CreditCard, Wallet, Building2, Landmark, PiggyBank, Banknote, ChevronDown, ChevronRight } from "lucide-react";
import type { AccountKind } from "@prisma/client";
import { PRODUCT_LABELS, type ProductType } from "@/lib/investment-config";
import { kindIconName, kindLabel, kindColor, kindOrder, institutionTypeLabel } from "@/lib/account-kinds";
import { EntityCreateForm } from "@/components/EntityCreateForm";
import { SmartSelect } from "@/components/SmartSelect";

/* ---- Render icon from kindIconName ---- */
function kindIcon(k: string) {
  const map: Record<string, React.ReactNode> = {
    "credit-card": <CreditCard className="w-3.5 h-3.5" />,
    "landmark": <Landmark className="w-3.5 h-3.5" />,
    "wallet": <Wallet className="w-3.5 h-3.5" />,
    "banknote": <Banknote className="w-3.5 h-3.5" />,
    "piggy-bank": <PiggyBank className="w-3.5 h-3.5" />,
    "building-2": <Building2 className="w-3.5 h-3.5" />,
  };
  return map[kindIconName(k)] || <Building2 className="w-3.5 h-3.5" />;
}

type Group = { id: string; name: string; sortOrder: number };
type Institution = { id: string; name: string; type?: string };
type Account = {
  id: string; name: string; kind: AccountKind; currency: string; isActive: boolean;
  isPlaceholder?: boolean;
  institutionId: string | null; groupId: string | null;
  Institution: { id: string; name: string } | null;
  AccountGroup: { id: string; name: string } | null;
  billingDay: number | null; repaymentDay: number | null;
  creditLimit: string | null; numberMasked: string | null;
  investProductType: string | null; costBasisMethod: string | null;
};

const investmentProductTypeOptions = (Object.keys(PRODUCT_LABELS) as ProductType[]).map((value) => ({ value, label: PRODUCT_LABELS[value] }));
const investmentProductTypeLabel = (value: string | null | undefined) => PRODUCT_LABELS[(value || "fund") as ProductType] || "开放式基金";

export default function SettingsAccountsPage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<string>("");
  const [selectedInstitution, setSelectedInstitution] = useState<string>("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Record<string, string>>({});
  const [collapsedKinds, setCollapsedKinds] = useState<Set<string>>(new Set());

  // Delete account with password verification
  const [deleteTarget, setDeleteTarget] = useState<Account | null>(null);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteError, setDeleteError] = useState("");

  // Nested creation from SmartSelect in inline edit
  const [nestedEntityType, setNestedEntityType] = useState<"institution" | "group" | null>(null);

  // Group CRUD
  const [newGroupName, setNewGroupName] = useState("");
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [editGroupId, setEditGroupId] = useState<string | null>(null);
  const [editGroupName, setEditGroupName] = useState("");

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
    setShowNewGroup(false);
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
    if (data.ok) { setSelectedGroup(""); loadAll(); }
    else window.alert(data.error);
  }

  // ---- Account handlers ----
  function openEdit(a: Account) {
    setEditingId(a.id);
    setEditForm({
      name: a.name,
      kind: a.kind,
      groupId: a.groupId || "",
      institutionId: a.institutionId || "",
      billingDay: a.billingDay?.toString() || "",
      repaymentDay: a.repaymentDay?.toString() || "",
      creditLimit: a.creditLimit || "",
      numberMasked: a.numberMasked || "",
      investProductType: a.investProductType || "fund",
      costBasisMethod: a.costBasisMethod || "moving_avg",
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

  const accountDisplayName = (account: Account) => account.Institution?.name ? `${account.Institution.name}·${account.name}` : account.name;

  const filteredAccounts = accounts.filter(a => {
    if (selectedGroup && a.groupId !== selectedGroup) return false;
    if (selectedInstitution && a.institutionId !== selectedInstitution) return false;
    return true;
  });

  // Group accounts by kind for display
  const grouped = new Map<string, Account[]>();
  for (const a of filteredAccounts) {
    const list = grouped.get(a.kind) || [];
    list.push(a);
    grouped.set(a.kind, list);
  }

  // Group/institution counts
  const groupAccountCounts = new Map<string, number>();
  for (const a of accounts) { if (a.groupId) groupAccountCounts.set(a.groupId, (groupAccountCounts.get(a.groupId) || 0) + 1); }
  const institutionAccountCounts = new Map<string, number>();
  for (const a of accounts) { if (a.institutionId) institutionAccountCounts.set(a.institutionId, (institutionAccountCounts.get(a.institutionId) || 0) + 1); }

  return (
    <div className="space-y-4">
      {/* ===== 标题行 ===== */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">账户管理</h2>
          <p className="text-xs text-slate-500 mt-0.5">共 {filteredAccounts.length} 个账户</p>
        </div>
        <EntityCreateForm
          mode="full" layout="card" entityType="account"
          fieldData={{ groupId: groups, institutionId: institutions }}
          onCreated={() => loadAll()}
          existingNames={accounts.map(a => a.name)}
        />
      </div>

      {/* ===== 顶部筛选条 ===== */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1">
          <select value={selectedGroup} onChange={e => setSelectedGroup(e.target.value)}
            className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400">
            <option value="">全部分组</option>
            {groups.map(g => <option key={g.id} value={g.id}>{g.name} ({groupAccountCounts.get(g.id) || 0})</option>)}
          </select>
          {/* 分组管理：新建/编辑/删除 */}
          {!showNewGroup ? (
            <button onClick={() => setShowNewGroup(true)} title="新建分组"
              className="h-9 w-9 flex items-center justify-center rounded-md border border-slate-200 bg-white text-slate-400 hover:text-blue-600 hover:bg-blue-50">
              <Plus className="w-3.5 h-3.5" />
            </button>
          ) : (
            <div className="flex items-center gap-1">
              <input value={newGroupName} onChange={e => setNewGroupName(e.target.value)}
                onKeyDown={e => e.key === "Enter" && createGroup()}
                className="h-9 rounded-md border border-blue-200 px-2 text-sm outline-none focus:border-blue-400 w-28" placeholder="分组名称" autoFocus />
              <button onClick={createGroup} disabled={!newGroupName.trim()}
                className="h-9 w-9 flex items-center justify-center rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
                <Check className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => { setShowNewGroup(false); setNewGroupName(""); }}
                className="h-9 w-9 flex items-center justify-center rounded-md border border-slate-200 bg-white text-slate-400 hover:bg-slate-50">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
          {editGroupId && (
            <div className="flex items-center gap-1">
              <input value={editGroupName} onChange={e => setEditGroupName(e.target.value)}
                onKeyDown={e => e.key === "Enter" && updateGroup()}
                className="h-9 rounded-md border border-blue-200 px-2 text-sm outline-none focus:border-blue-400 w-28" autoFocus />
              <button onClick={updateGroup}
                className="h-9 w-9 flex items-center justify-center rounded-md bg-blue-600 text-white hover:bg-blue-700">
                <Check className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => setEditGroupId(null)}
                className="h-9 w-9 flex items-center justify-center rounded-md border border-slate-200 bg-white text-slate-400 hover:bg-slate-50">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
        <select value={selectedInstitution} onChange={e => setSelectedInstitution(e.target.value)}
          className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400">
          <option value="">全部机构</option>
          {institutions.map(i => <option key={i.id} value={i.id}>{i.name} ({institutionAccountCounts.get(i.id) || 0})</option>)}
        </select>
        {/* 分组列表（编辑/删除） */}
        {groups.length > 0 && (
          <div className="flex items-center gap-1 text-xs text-slate-400">
            {groups.map(g => (
              <span key={g.id} className="group inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full border border-slate-200 bg-slate-50 hover:border-slate-300">
                <span className="text-slate-600">{g.name}</span>
                <button onClick={() => { setEditGroupId(g.id); setEditGroupName(g.name); }} title="编辑分组"
                  className="hidden group-hover:inline-flex h-4 w-4 items-center justify-center rounded text-slate-400 hover:text-blue-600">
                  <Pencil className="w-2.5 h-2.5" />
                </button>
                <button onClick={() => { if (confirm("删除分组？")) deleteGroup(g.id); }} title="删除分组"
                  className="hidden group-hover:inline-flex h-4 w-4 items-center justify-center rounded text-slate-400 hover:text-red-500">
                  <Trash2 className="w-2.5 h-2.5" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* ===== 账户列表（按类型分组，可折叠） ===== */}
      {kindOrder.map(kind => {
        const list = grouped.get(kind);
        if (!list || list.length === 0) return null;
        const collapsed = collapsedKinds.has(kind);
        return (
          <div key={kind} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <button onClick={() => setCollapsedKinds(prev => { const s = new Set(prev); if (s.has(kind)) s.delete(kind); else s.add(kind); return s; })}
              className="w-full px-4 py-3 border-b border-slate-100 flex items-center justify-between cursor-pointer hover:bg-slate-50/50 transition-colors">
              <div className="flex items-center gap-2">
                <span className={`text-xs font-semibold px-2 py-0.5 rounded border ${kindColor(kind)}`}>
                  {kindIcon(kind)} {kindLabel(kind)}
                </span>
                <span className="text-xs text-slate-500">{list.length} 个</span>
              </div>
              {collapsed ? <ChevronRight className="w-3.5 h-3.5 text-slate-400" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-400" />}
            </button>
            {!collapsed && (
            <div className="divide-y divide-slate-100">
              {list.map(a => (
                editingId === a.id ? (
                  /* ---- Edit mode ---- */
                  <div key={a.id} className="p-4 bg-blue-50/30">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">名称</label>
                        <input value={editForm.name || ""} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
                          className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none focus:border-blue-400" />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">分组</label>
                        <SmartSelect mode="single" value={editForm.groupId || ""}
                          onChange={id => setEditForm(f => ({ ...f, groupId: id }))}
                          options={groups.map(g => ({ id: g.id, label: g.name }))}
                          placeholder="选择分组"
                          onCreateClick={() => setNestedEntityType("group")} createLabel="新增分组" />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">机构</label>
                        <SmartSelect mode="single" value={editForm.institutionId || ""}
                          onChange={id => setEditForm(f => ({ ...f, institutionId: id }))}
                          options={institutions.map(i => ({
                            id: i.id, label: i.name,

                            subLabel: institutionTypeLabel(i.type ?? null),
                          }))}
                          placeholder="选择机构"
                          onCreateClick={() => setNestedEntityType("institution")} createLabel="新增机构" />
                      </div>
                      {a.kind === "investment" && (
                        <div>
                          <label className="block text-xs text-slate-500 mb-1">投资账户类型</label>
                          <select value={editForm.investProductType || "fund"} onChange={e => setEditForm(f => ({ ...f, investProductType: e.target.value }))}
                            className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none">
                            {investmentProductTypeOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                          </select>
                        </div>
                      )}
                    </div>

                    {a.kind === "investment" && (
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
                        <div>
                          <label className="block text-xs text-slate-500 mb-1">成本摊薄方式</label>
                          <select value={editForm.costBasisMethod || "moving_avg"} onChange={e => setEditForm(f => ({ ...f, costBasisMethod: e.target.value }))}
                            className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none">
                            <option value="moving_avg">移动平均</option>
                            <option value="fifo">先进先出</option>
                            <option value="lifo">后进先出</option>
                          </select>
                        </div>
                      </div>
                    )}

                    {(a.kind === "bank_credit" || a.kind === "loan") && (
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
                        <div>
                          <label className="block text-xs text-slate-500 mb-1">账单日</label>
                          <input value={editForm.billingDay || ""} onChange={e => setEditForm(f => ({ ...f, billingDay: e.target.value }))}
                            className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none" placeholder="1-31" />
                        </div>
                        <div>
                          <label className="block text-xs text-slate-500 mb-1">还款日</label>
                          <input value={editForm.repaymentDay || ""} onChange={e => setEditForm(f => ({ ...f, repaymentDay: e.target.value }))}
                            className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none" placeholder="1-31" />
                        </div>
                        <div>
                          <label className="block text-xs text-slate-500 mb-1">额度</label>
                          <input value={editForm.creditLimit || ""} onChange={e => setEditForm(f => ({ ...f, creditLimit: e.target.value }))}
                            className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none" />
                        </div>
                        <div>
                          <label className="block text-xs text-slate-500 mb-1">卡号后四位</label>
                          <input value={editForm.numberMasked || ""} onChange={e => setEditForm(f => ({ ...f, numberMasked: e.target.value }))}
                            className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none" />
                        </div>
                      </div>
                    )}

                    <div className="flex justify-end gap-2 mt-3">
                      <button onClick={() => setEditingId(null)}
                        className="h-7 px-3 rounded-md border border-slate-200 bg-white text-xs text-slate-600 hover:bg-slate-50">取消</button>
                      <button onClick={saveEdit}
                        className="h-7 px-3 rounded-md bg-blue-600 text-white text-xs hover:bg-blue-700">保存</button>
                    </div>
                  </div>
                ) : (
                  /* ---- View mode ---- */
                  <div key={a.id} className={`px-4 py-2.5 flex items-center justify-between ${a.isPlaceholder ? "opacity-40 bg-slate-50" : !a.isActive ? "opacity-60" : ""} ${!a.isPlaceholder ? "hover:bg-slate-50" : ""} transition-colors`}>
                    <div className="flex-1 min-w-0 flex items-center gap-2">
                      <span className="text-sm font-medium text-slate-800 truncate">{accountDisplayName(a)}</span>
                      {a.isPlaceholder && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-slate-300 bg-slate-100 text-slate-400">占位</span>
                      )}
                      {a.AccountGroup && (
                        <span className="text-xs px-1.5 py-0.5 rounded-full border border-slate-200 bg-slate-50 text-slate-600">{a.AccountGroup.name}</span>
                      )}
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${a.isActive ? "bg-emerald-50 text-emerald-600 border-emerald-200" : "bg-slate-100 text-slate-400 border-slate-200"}`}>
                        {a.isActive ? "启用" : "停用"}
                      </span>
                      {a.kind === "investment" && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-purple-200 bg-purple-50 text-purple-700">
                          {investmentProductTypeLabel(a.investProductType)}
                        </span>
                      )}
                      {(a.kind === "bank_credit" || a.kind === "loan") && (
                        <>
                          {a.billingDay && <span className="text-[10px] text-slate-400">账单{a.billingDay}日</span>}
                          {a.repaymentDay && <span className="text-[10px] text-slate-400">还款{a.repaymentDay}日</span>}
                          {a.creditLimit && <span className="text-[10px] text-slate-400">额度￥{a.creditLimit}</span>}
                          {a.numberMasked && <span className="text-[10px] text-slate-400">尾号{a.numberMasked}</span>}
                        </>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0 ml-3">
                      {!a.isPlaceholder && (
                      <button onClick={() => toggleActive(a.id)}
                        className="h-7 w-7 flex items-center justify-center rounded-md border border-slate-200 bg-white hover:bg-slate-50"
                        title={a.isActive ? "停用" : "启用"}>
                        {a.isActive ? <PowerOff className="w-3 h-3 text-slate-400" /> : <Power className="w-3 h-3 text-amber-500" />}
                      </button>
                      )}
                      {!a.isPlaceholder && (
                      <button onClick={() => openEdit(a)}
                        className="h-7 w-7 flex items-center justify-center rounded-md border border-slate-200 bg-white hover:bg-slate-50"
                        title="编辑">
                        <Pencil className="w-3 h-3 text-slate-400" />
                      </button>
                      )}
                      {!a.isPlaceholder && (
                      <button onClick={async () => {
                        if (!confirm(`删除账户"${a.name}"？`)) return;
                        const res = await fetch(`/api/v1/accounts?id=${a.id}`, { method: "DELETE" });
                        const data = await res.json();
                        if (data.ok) { loadAll(); return; }
                        if (data.needPassword) {
                          setDeleteTarget(a);
                          setDeletePassword("");
                          setDeleteError("");
                          return;
                        }
                        window.alert(data.error);
                      }}
                        className="h-7 w-7 flex items-center justify-center rounded-md border border-slate-200 bg-white hover:bg-red-50 hover:border-red-200"
                        title="删除">
                        <Trash2 className="w-3 h-3 text-slate-400" />
                      </button>
                      )}
                    </div>
                  </div>
                )
              ))}
            </div>
            )}
          </div>
        );
      })}

      {filteredAccounts.length === 0 && (
        <div className="bg-white border border-slate-200 rounded-xl py-12 text-center text-sm text-slate-400">
          暂无账户。点击右上角"新增账户"按钮添加。
        </div>
      )}

      {/* Nested creation modals from SmartSelect in inline edit */}
      {nestedEntityType && (
        <EntityCreateForm
          mode="compact"
          entityType={nestedEntityType}
          open={true}
          onClose={() => setNestedEntityType(null)}
          onCreated={(id, name, extra) => {
            if (nestedEntityType === "institution") {
              setInstitutions(prev => [...prev, { id, name, type: extra?.type }]);
              setEditForm(f => ({ ...f, institutionId: id }));
            } else if (nestedEntityType === "group") {
              setGroups(prev => [...prev, { id, name, sortOrder: prev.length }]);
              setEditForm(f => ({ ...f, groupId: id }));
            }
            setNestedEntityType(null);
          }}
        />
      )}

      {/* Password confirmation dialog for deleting account with records */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-[1px] p-4"
          onMouseDown={() => { setDeleteTarget(null); setDeleteError(""); }}>
          <div className="w-[340px] max-w-[calc(100vw-2rem)] rounded-xl border border-slate-200 bg-white shadow-xl p-4"
            onMouseDown={e => e.stopPropagation()}>
            <div className="text-sm font-semibold text-slate-800 mb-1">验证密码</div>
            <div className="text-xs text-slate-500 mb-3">
              账户「{deleteTarget.name}」已产生记录，需输入密码确认删除。删除后记录中的账户将变为「空白」。
            </div>
            <input
              type="password"
              value={deletePassword}
              onChange={e => { setDeletePassword(e.target.value); setDeleteError(""); }}
              onKeyDown={async e => {
                if (e.key === "Enter") {
                  const res = await fetch(`/api/v1/accounts?id=${deleteTarget.id}`, {
                    method: "DELETE",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ password: deletePassword }),
                  });
                  const data = await res.json();
                  if (data.ok) { setDeleteTarget(null); loadAll(); }
                  else setDeleteError(data.error);
                }
              }}
              placeholder="输入密码"
              autoFocus
              className="h-9 w-full rounded-md border border-slate-200 px-3 text-sm outline-none focus:border-blue-400"
            />
            {deleteError && <div className="text-xs text-red-500 mt-1">{deleteError}</div>}
            <div className="flex justify-end gap-2 mt-3">
              <button onClick={() => { setDeleteTarget(null); setDeleteError(""); }}
                className="h-8 px-3 rounded-md border border-slate-200 bg-white text-xs text-slate-600 hover:bg-slate-50">取消</button>
              <button onClick={async () => {
                const res = await fetch(`/api/v1/accounts?id=${deleteTarget.id}`, {
                  method: "DELETE",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ password: deletePassword }),
                });
                const data = await res.json();
                if (data.ok) { setDeleteTarget(null); loadAll(); }
                else setDeleteError(data.error);
              }}
                className="h-8 px-3 rounded-md bg-red-600 text-white text-xs hover:bg-red-700">确认删除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
