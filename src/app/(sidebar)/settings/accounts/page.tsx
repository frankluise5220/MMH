"use client";

import { useState, useEffect } from "react";
import { Plus, Trash2, Pencil, Power, PowerOff, CreditCard, Wallet, Building2, Landmark, PiggyBank, Banknote, ChevronDown, ChevronRight } from "lucide-react";
import type { AccountKind } from "@prisma/client";
import { PRODUCT_LABELS, type ProductType } from "@/lib/investment-config";
import { kindIconName, kindColor, kindOrder } from "@/lib/account-kinds";
import { EntityCreateForm } from "@/components/EntityCreateForm";
import { SmartSelect } from "@/components/SmartSelect";
import { fetchSettingsAccountData, getCachedSettingsAccountData, invalidateSettingsAccountData } from "@/lib/client/settingsCache";
import { isDepositAccount } from "@/lib/account-kind-utils";
import { useI18n } from "@/lib/i18n";

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

function normalizedAccountKind(account: Pick<Account, "kind" | "investProductType">): AccountKind {
  return isDepositAccount(account) ? ("deposit" as AccountKind) : account.kind;
}

export default function SettingsAccountsPage() {
  const { t } = useI18n();
  const tf = (key: string, values: Record<string, string | number>) => {
    let text: string = t(key);
    for (const [name, value] of Object.entries(values)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
    return text;
  };
  const accountKindLabel = (kind: string) => t(`account.kind.${kind}`);
  const institutionKindLabel = (type: string | null | undefined) => t(`institution.type.${type ?? "other"}`);
  const investmentLabel = (value: string | null | undefined) => t(`investment.product.${value || "fund"}`);
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
      return;
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

  function notifySidebarChanged() {
    window.dispatchEvent(new Event("mmh:fund:refresh"));
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
    notifySidebarChanged();
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
    notifySidebarChanged();
  }

  async function deleteGroup(id: string) {
    const res = await fetch("/api/v1/settings/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entity: "accountGroup", id }),
    });
    const data = await res.json();
    if (data.ok) {
      setSelectedGroup("");
      invalidateSettingsAccountData();
      loadAll({ force: true });
      notifySidebarChanged();
    }
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
    notifySidebarChanged();
  }

  async function toggleActive(id: string) {
    await fetch("/api/v1/accounts", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    invalidateSettingsAccountData();
    loadAll({ force: true });
    notifySidebarChanged();
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
    { id: "", label: t("settings.accounts.allOwners") },
    ...groups.map((g) => ({ id: g.id, label: g.name })),
  ];
  const institutionFilterOptions = [
    { id: "", label: t("settings.accounts.allInstitutions") },
    ...institutions.map((i) => ({
      id: i.id,
      label: i.shortName?.trim() || i.name,
      subLabel: [i.shortName?.trim() ? i.name : "", institutionKindLabel(i.type)].filter(Boolean).join(" · "),
    })),
  ];
  const kindFilterOptions = kindOrder.map((kind) => ({
    id: kind,
    label: accountKindLabel(kind),
  }));

  return (
    <div className="space-y-4">
      <div className="sticky top-0 z-20 space-y-3 border-b border-slate-200 bg-white/95 pb-3 pt-1 backdrop-blur supports-[backdrop-filter]:bg-white/85">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-800">{t("settings.accounts.title")}</h2>
            <p className="mt-0.5 text-xs text-slate-500">{tf("settings.accounts.count", { count: filteredAccounts.length })}</p>
          </div>
          <button
            type="button"
            onClick={() => setShowCreateAccount(true)}
            className="primary-button h-9 shrink-0 gap-1.5"
          >
            <Plus className="h-3.5 w-3.5" />{t("settings.accounts.add")}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="w-52 max-w-full">
            <SmartSelect
              mode="single"
              value={selectedGroup}
              onChange={setSelectedGroup}
              options={groupFilterOptions}
              placeholder={t("settings.accounts.filterOwner")}
            />
          </div>
          <div className="w-64 max-w-full">
            <SmartSelect
              mode="single"
              value={selectedInstitution}
              onChange={setSelectedInstitution}
              options={institutionFilterOptions}
              placeholder={t("settings.accounts.filterInstitution")}
              searchable={true}
            />
          </div>
          <div className="w-72 max-w-full">
            <SmartSelect
              mode="multi"
              value={selectedKinds}
              onChange={setSelectedKinds}
              options={kindFilterOptions}
              placeholder={t("settings.accounts.filterKind")}
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
                  <span>{accountKindLabel(kind)}</span>
                </span>
                <span className="text-xs text-slate-500">{tf("settings.accounts.kindCount", { count: list.length })}</span>
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
                        <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.name")}</label>
                        <input value={editForm.name || ""} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
                          className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none focus:border-blue-400" />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.type")}</label>
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
                          <option value="cash">{t("account.kind.cash")}</option>
                          <option value="bank_debit">{t("account.kind.bank_debit")}</option>
                          <option value="bank_credit">{t("account.kind.bank_credit")}</option>
                          <option value="ewallet">{t("account.kind.ewallet")}</option>
                          <option value="deposit">{t("account.kind.deposit")}</option>
                          <option value="investment">{t("account.kind.investment")}</option>
                          <option value="loan">{t("account.kind.loan")}</option>
                          <option value="other">{t("account.kind.other")}</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.owner")}</label>
                        <SmartSelect mode="single" value={editForm.groupId || ""}
                          onChange={id => setEditForm(f => ({ ...f, groupId: id }))}
                          options={groups.map(g => ({ id: g.id, label: g.name }))}
                          placeholder={t("settings.accounts.selectOwner")}
                          onCreateClick={() => setNestedEntityType("group")} createLabel={t("settings.accounts.addOwner")} />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.institution")}</label>
                        <SmartSelect mode="single" value={editForm.institutionId || ""}
                          onChange={id => setEditForm(f => ({ ...f, institutionId: id }))}
                          options={filteredInstitutions.map(i => ({
                            id: i.id,
                            label: i.shortName?.trim() || i.name,
                            subLabel: [i.shortName?.trim() ? i.name : "", institutionKindLabel(i.type)].filter(Boolean).join(" · "),
                          }))}
                          placeholder={t("settings.accounts.selectInstitution")}
                          onCreateClick={() => setNestedEntityType("institution")} createLabel={t("settings.accounts.addInstitution")} />
                      </div>
                      {isInvestmentKind && (
                        <div>
                          <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.investmentAccountType")}</label>
                          <select value={editForm.investProductType || "fund"} onChange={e => setEditForm(f => ({ ...f, investProductType: e.target.value }))}
                            className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none">
                            {investmentProductTypeOptions.map((item) => <option key={item.value} value={item.value}>{investmentLabel(item.value)}</option>)}
                          </select>
                        </div>
                      )}
                    </div>

                    {isInvestmentKind && (
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
                        <div>
                          <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.costBasisMethod")}</label>
                          <select value={editForm.costBasisMethod || "moving_avg"} onChange={e => setEditForm(f => ({ ...f, costBasisMethod: e.target.value }))}
                            className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none">
                            <option value="moving_avg">{t("settings.accounts.movingAverage")}</option>
                            <option value="fifo">{t("settings.accounts.fifo")}</option>
                            <option value="lifo">{t("settings.accounts.lifo")}</option>
                          </select>
                        </div>
                        {(editForm.investProductType || "fund") === "fund" && (
                          <div>
                            <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.fundUnitsDecimals")}</label>
                            <input
                              value={editForm.fundUnitsDecimals || "3"}
                              onChange={e => setEditForm(f => ({ ...f, fundUnitsDecimals: e.target.value }))}
                              className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none"
                              inputMode="numeric"
                              placeholder={t("settings.accounts.defaultUnitsDecimals")}
                            />
                          </div>
                        )}
                      </div>
                    )}

                    {isBillLikeKind && (
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
                        <div>
                          <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.billingDayLabel")}</label>
                          <input value={editForm.billingDay || ""} onChange={e => setEditForm(f => ({ ...f, billingDay: e.target.value }))}
                            className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none" placeholder="1-31" />
                        </div>
                        <div>
                          <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.repaymentDayLabel")}</label>
                          <input value={editForm.repaymentDay || ""} onChange={e => setEditForm(f => ({ ...f, repaymentDay: e.target.value }))}
                            className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none" placeholder="1-31" />
                        </div>
                        <div>
                          <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.creditLimitLabel")}</label>
                          <input value={editForm.creditLimit || ""} onChange={e => setEditForm(f => ({ ...f, creditLimit: e.target.value }))}
                            className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none" />
                        </div>
                        <div>
                          <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.lastFourLabel")}</label>
                          <input value={editForm.numberMasked || ""} onChange={e => setEditForm(f => ({ ...f, numberMasked: e.target.value }))}
                            className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none" />
                        </div>
                      </div>
                    )}

                    <div className="flex justify-end gap-2 mt-3">
                      <button onClick={() => setEditingId(null)}
                        className="h-7 px-3 rounded-md border border-slate-200 bg-white text-xs text-slate-600 hover:bg-slate-50">{t("common.cancel")}</button>
                      <button onClick={saveEdit}
                        className="h-7 px-3 rounded-md bg-blue-600 text-white text-xs hover:bg-blue-700">{t("common.save")}</button>
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
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-slate-300 bg-slate-100 text-slate-400">{t("settings.accounts.placeholder")}</span>
                      )}
                      {a.AccountGroup && (
                        <span className="text-xs px-1.5 py-0.5 rounded-full border border-slate-200 bg-slate-50 text-slate-600">{a.AccountGroup.name}</span>
                      )}
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${a.isActive ? "bg-emerald-50 text-emerald-600 border-emerald-200" : "bg-slate-100 text-slate-400 border-slate-200"}`}>
                        {a.isActive ? t("common.enabled") : t("common.disabled")}
                      </span>
                      {normalizedAccountKind(a) === "investment" && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-purple-200 bg-purple-50 text-purple-700">
                          {investmentLabel(a.investProductType)}
                        </span>
                      )}
                      {normalizedAccountKind(a) === "investment" && (a.investProductType ?? "fund") === "fund" && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-slate-200 bg-slate-50 text-slate-600">
                          {tf("settings.accounts.unitsDecimals", { count: a.fundUnitsDecimals ?? 3 })}
                        </span>
                      )}
                      {normalizedAccountKind(a) === "bank_credit" && (
                        <>
                          {a.billingDay && <span className="text-[10px] text-slate-400">{tf("settings.accounts.billingDay", { day: a.billingDay })}</span>}
                          {a.repaymentDay && <span className="text-[10px] text-slate-400">{tf("settings.accounts.repaymentDay", { day: a.repaymentDay })}</span>}
                          {a.creditLimit && <span className="text-[10px] text-slate-400">{tf("settings.accounts.creditLimit", { amount: a.creditLimit })}</span>}
                          {a.numberMasked && <span className="text-[10px] text-slate-400">{tf("settings.accounts.lastFour", { value: a.numberMasked })}</span>}
                        </>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0 ml-3">
                      {!a.isPlaceholder && (
                      <button onClick={() => toggleActive(a.id)}
                        className="h-7 w-7 flex items-center justify-center rounded-md border border-slate-200 bg-white hover:bg-slate-50"
                        title={a.isActive ? t("common.disabled") : t("common.enabled")}>
                        {a.isActive ? <PowerOff className="w-3 h-3 text-slate-400" /> : <Power className="w-3 h-3 text-amber-500" />}
                      </button>
                      )}
                      {!a.isPlaceholder && (
                      <button onClick={() => openEdit(a)}
                        className="h-7 w-7 flex items-center justify-center rounded-md border border-slate-200 bg-white hover:bg-slate-50"
                        title={t("common.edit")}>
                        <Pencil className="w-3 h-3 text-slate-400" />
                      </button>
                      )}
                      {!a.isPlaceholder && (
                      <button onClick={async () => {
                        if (!confirm(tf("settings.accounts.deleteConfirm", { name: a.name }))) return;
                        const res = await fetch(`/api/v1/accounts?id=${a.id}`, { method: "DELETE" });
                        const data = await res.json();
                        if (data.ok) {
                          invalidateSettingsAccountData();
                          loadAll({ force: true });
                          notifySidebarChanged();
                          return;
                        }
                        if (data.needPassword) {
                          setDeleteTarget(a);
                          setDeletePassword("");
                          setDeleteError("");
                          return;
                        }
                        window.alert(data.error);
                      }}
                        className="h-7 w-7 flex items-center justify-center rounded-md border border-slate-200 bg-white hover:bg-red-50 hover:border-red-200"
                        title={t("common.delete")}>
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
          {t("settings.accounts.empty")}
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
          notifySidebarChanged();
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
            <div className="text-sm font-semibold text-slate-800 mb-1">{t("settings.accounts.passwordTitle")}</div>
            <div className="text-xs text-slate-500 mb-3">
              {tf("settings.accounts.passwordDesc", { name: deleteTarget.name })}
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
                  if (data.ok) {
                    setDeleteTarget(null);
                    invalidateSettingsAccountData();
                    loadAll({ force: true });
                    notifySidebarChanged();
                  }
                  else setDeleteError(data.error);
                }
              }}
              placeholder={t("settings.accounts.passwordPlaceholder")}
              autoFocus
              className="h-9 w-full rounded-md border border-slate-200 px-3 text-sm outline-none focus:border-blue-400"
            />
            {deleteError && <div className="text-xs text-red-500 mt-1">{deleteError}</div>}
            <div className="flex justify-end gap-2 mt-3">
              <button onClick={() => { setDeleteTarget(null); setDeleteError(""); }}
                className="h-8 px-3 rounded-md border border-slate-200 bg-white text-xs text-slate-600 hover:bg-slate-50">{t("common.cancel")}</button>
              <button onClick={async () => {
                const res = await fetch(`/api/v1/accounts?id=${deleteTarget.id}`, {
                  method: "DELETE",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ password: deletePassword }),
                });
                const data = await res.json();
                if (data.ok) {
                  setDeleteTarget(null);
                  invalidateSettingsAccountData();
                  loadAll({ force: true });
                  notifySidebarChanged();
                }
                else setDeleteError(data.error);
              }}
                className="h-8 px-3 rounded-md bg-red-600 text-white text-xs hover:bg-red-700">{t("settings.accounts.confirmDelete")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
