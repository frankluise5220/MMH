"use client";

import { useState, useEffect } from "react";
import { Plus, Trash2, Pencil, Check, X, Power, PowerOff, CreditCard, Wallet, Building2, Landmark, PiggyBank, Banknote, ChevronDown, ChevronRight } from "lucide-react";
import type { AccountKind } from "@prisma/client";
import { PRODUCT_LABELS, type ProductType } from "@/lib/investment-config";
import { kindIconName, kindLabel, kindColor, kindOrder, institutionTypeLabel } from "@/lib/account-kinds";
import { EntityCreateForm } from "@/components/EntityCreateForm";
import { SmartSelect } from "@/components/SmartSelect";
import { fetchSettingsAccountData, getCachedSettingsAccountData, invalidateSettingsAccountData } from "@/lib/client/settingsCache";
import { isDepositAccount } from "@/lib/account-kind-utils";

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
type Institution = { id: string; name: string; shortName?: string | null; type?: string };
type Account = {
  id: string; name: string; kind: AccountKind; currency: string; isActive: boolean;
  isPlaceholder?: boolean;
  institutionId: string | null; groupId: string | null;
  Institution: { id: string; name: string; shortName?: string | null } | null;
  AccountGroup: { id: string; name: string } | null;
  billingDay: number | null; repaymentDay: number | null;
  creditLimit: string | null; numberMasked: string | null;
  investProductType: string | null; costBasisMethod: string | null;
  fundUnitsDecimals?: number | null;
};

const investmentProductTypeOptions = (Object.keys(PRODUCT_LABELS) as ProductType[]).map((value) => ({ value, label: PRODUCT_LABELS[value] }));
const investmentProductTypeLabel = (value: string | null | undefined) => PRODUCT_LABELS[(value || "fund") as ProductType] || "开放式基金";

function normalizedAccountKind(account: Pick<Account, "kind" | "investProductType">): AccountKind {
  return isDepositAccount(account) ? ("deposit" as AccountKind) : account.kind;
}

export default function SettingsAccountsPage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<string>("");
  const [selectedInstitution, setSelectedInstitution] = useState<string>("");
  const [selectedKinds, setSelectedKinds] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Record<string, string>>({});
  const [collapsedKinds, setCollapsedKinds] = useState<Set<string>>(new Set());
  const [showCreateAccount, setShowCreateAccount] = useState(false);

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

  useEffect(() => {
    const cached = getCachedSettingsAccountData();
    if (cached) {
      setGroups(cached.groups as Group[]);
      setAccounts(cached.accounts as Account[]);
      setInstitutions(cached.institutions as Institution[]);
    }
    loadAll();
  }, []);

  async function loadAll(options?: { force?: boolean }) {
    const data = await fetchSettingsAccountData(options).catch(() => null);
    if (!data) return;
    setGroups(data.groups as Group[]);
    setAccounts(data.accounts as Account[]);
    setInstitutions(data.institutions as Institution[]);
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
    invalidateSettingsAccountData();
    loadAll({ force: true });
  }

  async function updateGroup() {
    if (!editGroupId || !editGroupName.trim()) return;
    await fetch("/api/v1/account-group", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: editGroupId, name: editGroupName.trim() }),
    });
    setEditGroupId(null);
    invalidateSettingsAccountData();
    loadAll({ force: true });
  }

  async function deleteGroup(id: string) {
    const res = await fetch("/api/v1/settings/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entity: "accountGroup", id }),
    });
    const data = await res.json();
    if (data.ok) { setSelectedGroup(""); invalidateSettingsAccountData(); loadAll({ force: true }); }
    else window.alert(data.error);
  }

  // ---- Account handlers ----
  function openEdit(a: Account) {
    const normalizedKind = normalizedAccountKind(a);
    setEditingId(a.id);
    setEditForm({
      name: a.name,
      kind: normalizedKind,
      groupId: a.groupId || "",
      institutionId: a.institutionId || "",
      billingDay: a.billingDay?.toString() || "",
      repaymentDay: a.repaymentDay?.toString() || "",
      creditLimit: a.creditLimit || "",
      numberMasked: a.numberMasked || "",
      investProductType: normalizedKind === "investment" ? (a.investProductType || "fund") : "",
      costBasisMethod: a.costBasisMethod || "moving_avg",
      fundUnitsDecimals: String(a.fundUnitsDecimals ?? 3),
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
    invalidateSettingsAccountData();
    loadAll({ force: true });
  }

  async function toggleActive(id: string) {
    await fetch("/api/v1/accounts", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    invalidateSettingsAccountData();
    loadAll({ force: true });
  }

  const accountDisplayName = (account: Account) => {
    const institutionLabel = account.Institution?.shortName?.trim() || account.Institution?.name || "";
    return institutionLabel ? `${institutionLabel}·${account.name}` : account.name;
  };

  const filteredAccounts = accounts.filter(a => {
    if (selectedGroup && a.groupId !== selectedGroup) return false;
    if (selectedInstitution && a.institutionId !== selectedInstitution) return false;
    if (selectedKinds.length > 0 && !selectedKinds.includes(normalizedAccountKind(a))) return false;
    return true;
  });

  // Group accounts by kind for display
  const grouped = new Map<string, Account[]>();
  for (const a of filteredAccounts) {
    const normalizedKind = normalizedAccountKind(a);
    const list = grouped.get(normalizedKind) || [];
    list.push(a);
    grouped.set(normalizedKind, list);
  }

  const groupFilterOptions = [
    { id: "", label: "全部所有人" },
    ...groups.map((g) => ({ id: g.id, label: g.name })),
  ];
  const institutionFilterOptions = [
    { id: "", label: "全部机构/人员" },
    ...institutions.map((i) => ({
      id: i.id,
      label: i.shortName?.trim() || i.name,
      subLabel: [i.shortName?.trim() ? i.name : "", institutionTypeLabel(i.type ?? null)].filter(Boolean).join(" · "),
    })),
  ];
  const kindFilterOptions = kindOrder.map((kind) => ({
    id: kind,
    label: kindLabel(kind),
  }));

  return (
    <div className="space-y-4">
      <div className="sticky top-0 z-20 space-y-3 border-b border-slate-200 bg-white/95 pb-3 pt-1 backdrop-blur supports-[backdrop-filter]:bg-white/85">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-800">账户管理</h2>
            <p className="mt-0.5 text-xs text-slate-500">共 {filteredAccounts.length} 个账户</p>
          </div>
          <button
            type="button"
            onClick={() => setShowCreateAccount(true)}
            className="primary-button h-9 shrink-0 gap-1.5"
          >
            <Plus className="h-3.5 w-3.5" />新增账户
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="w-52 max-w-full">
            <SmartSelect
              mode="single"
              value={selectedGroup}
              onChange={setSelectedGroup}
              options={groupFilterOptions}
              placeholder="筛选所有人"
            />
          </div>
          <div className="w-64 max-w-full">
            <SmartSelect
              mode="single"
              value={selectedInstitution}
              onChange={setSelectedInstitution}
              options={institutionFilterOptions}
              placeholder="筛选机构/人员"
              searchable={true}
            />
          </div>
          <div className="w-72 max-w-full">
            <SmartSelect
              mode="multi"
              value={selectedKinds}
              onChange={setSelectedKinds}
              options={kindFilterOptions}
              placeholder="筛选账户类型"
            />
          </div>
        </div>
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
                <span className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs font-semibold ${kindColor(kind)}`}>
                  <span className="shrink-0">{kindIcon(kind)}</span>
                  <span>{kindLabel(kind)}</span>
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
                    {(() => {
                      const normalizedKind = normalizedAccountKind(a);
                      const editKind = (editForm.kind || normalizedKind) as AccountKind;
                      const isInvestmentKind = editKind === "investment";
                      const isBillLikeKind = editKind === "bank_credit";
                      const filteredInstitutions = institutions.filter((institution) =>
                        editKind === "loan" ? institution.type === "debt" : institution.type !== "debt",
                      );
                      return (
                        <>
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">名称</label>
                        <input value={editForm.name || ""} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
                          className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none focus:border-blue-400" />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">类型</label>
                        <select
                          value={editKind}
                          onChange={e => setEditForm(f => ({
                            ...f,
                            kind: e.target.value,
                            institutionId: "",
                            investProductType: e.target.value === "investment" ? (f.investProductType || "fund") : "",
                          }))}
                          className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none"
                        >
                          <option value="cash">现金</option>
                          <option value="bank_debit">借记卡</option>
                          <option value="bank_credit">信用卡</option>
                          <option value="ewallet">电子钱包</option>
                          <option value="deposit">存款</option>
                          <option value="investment">投资</option>
                          <option value="loan">借入/借出</option>
                          <option value="other">其他</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">所有人</label>
                        <SmartSelect mode="single" value={editForm.groupId || ""}
                          onChange={id => setEditForm(f => ({ ...f, groupId: id }))}
                          options={groups.map(g => ({ id: g.id, label: g.name }))}
                          placeholder="选择所有人"
                          onCreateClick={() => setNestedEntityType("group")} createLabel="新增所有人" />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">机构</label>
                        <SmartSelect mode="single" value={editForm.institutionId || ""}
                          onChange={id => setEditForm(f => ({ ...f, institutionId: id }))}
                          options={filteredInstitutions.map(i => ({
                            id: i.id,
                            label: i.shortName?.trim() || i.name,
                            subLabel: [i.shortName?.trim() ? i.name : "", institutionTypeLabel(i.type ?? null)].filter(Boolean).join(" · "),
                          }))}
                          placeholder="选择机构"
                          onCreateClick={() => setNestedEntityType("institution")} createLabel="新增机构" />
                      </div>
                      {isInvestmentKind && (
                        <div>
                          <label className="block text-xs text-slate-500 mb-1">投资账户类型</label>
                          <select value={editForm.investProductType || "fund"} onChange={e => setEditForm(f => ({ ...f, investProductType: e.target.value }))}
                            className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none">
                            {investmentProductTypeOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                          </select>
                        </div>
                      )}
                    </div>

                    {isInvestmentKind && (
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
                        {(editForm.investProductType || "fund") === "fund" && (
                          <div>
                            <label className="block text-xs text-slate-500 mb-1">份额位数</label>
                            <input
                              value={editForm.fundUnitsDecimals || "3"}
                              onChange={e => setEditForm(f => ({ ...f, fundUnitsDecimals: e.target.value }))}
                              className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none"
                              inputMode="numeric"
                              placeholder="默认 3"
                            />
                          </div>
                        )}
                      </div>
                    )}

                    {isBillLikeKind && (
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
                        </>
                      );
                    })()}
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
                      {normalizedAccountKind(a) === "investment" && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-purple-200 bg-purple-50 text-purple-700">
                          {investmentProductTypeLabel(a.investProductType)}
                        </span>
                      )}
                      {normalizedAccountKind(a) === "investment" && (a.investProductType ?? "fund") === "fund" && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-slate-200 bg-slate-50 text-slate-600">
                          份额{a.fundUnitsDecimals ?? 3}位
                        </span>
                      )}
                      {normalizedAccountKind(a) === "bank_credit" && (
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
                        if (data.ok) { invalidateSettingsAccountData(); loadAll({ force: true }); return; }
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
          暂无账户。点击"新增账户"按钮添加。
        </div>
      )}

      <EntityCreateForm
        mode="full"
        layout="modal"
        entityType="account"
        open={showCreateAccount}
        onClose={() => setShowCreateAccount(false)}
        fieldData={{ groupId: groups, institutionId: institutions }}
        onCreated={() => {
          setShowCreateAccount(false);
          invalidateSettingsAccountData();
          loadAll({ force: true });
        }}
        existingNames={accounts.map(a => a.name)}
      />

      {/* Nested creation modals from SmartSelect in inline edit */}
      {nestedEntityType && (
        <EntityCreateForm
          mode="compact"
          entityType={nestedEntityType}
          open={true}
          onClose={() => setNestedEntityType(null)}
          onCreated={(id, name, extra) => {
            if (nestedEntityType === "institution") {
              setInstitutions(prev => [...prev, { id, name, shortName: extra?.institutionShortName ?? null, type: extra?.type }]);
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
                  if (data.ok) { setDeleteTarget(null); invalidateSettingsAccountData(); loadAll({ force: true }); }
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
                if (data.ok) { setDeleteTarget(null); invalidateSettingsAccountData(); loadAll({ force: true }); }
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
