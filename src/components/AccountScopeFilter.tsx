"use client";

import { ChevronDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";

export type StatisticsAccountItem = {
  id: string;
  name: string;
  kind?: string | null;
  label?: string;
  groupId?: string;
  userId?: string | null;
  Institution?: { id?: string; name: string } | null;
};

export type StatisticsInstitutionItem = { id: string; name: string; type?: string | null };
export type StatisticsUserItem = { id: string; name: string };
export const CASH_INSTITUTION_ID = "__cash__";

export type AccountScopeValue = {
  userIds: string[];
  institutionIds: string[];
  accountIds: string[];
};

type Props = {
  allAccounts: StatisticsAccountItem[];
  allInstitutions?: StatisticsInstitutionItem[];
  allUsers?: StatisticsUserItem[];
  value: AccountScopeValue;
  onChange: (next: AccountScopeValue) => void;
};

export function AccountScopeFilter({
  allAccounts,
  allInstitutions = [],
  allUsers = [],
  value,
  onChange,
}: Props) {
  const { t } = useI18n();
  const [openMenu, setOpenMenu] = useState<"users" | "institutions" | "accounts" | null>(null);
  const menuAnchorRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0 });
  const [draftUserIds, setDraftUserIds] = useState<string[]>(value.userIds);
  const [draftInstitutionIds, setDraftInstitutionIds] = useState<string[]>(value.institutionIds);
  const [draftAccountIds, setDraftAccountIds] = useState<string[]>(value.accountIds);
  const draftUserIdsRef = useRef(draftUserIds);
  const draftInstitutionIdsRef = useRef(draftInstitutionIds);
  const draftAccountIdsRef = useRef(draftAccountIds);

  const userIds = value.userIds;
  const institutionIds = value.institutionIds;
  const accountIds = value.accountIds;

  useEffect(() => {
    setDraftUserIds(value.userIds);
    setDraftInstitutionIds(value.institutionIds);
    setDraftAccountIds(value.accountIds);
  }, [value.userIds, value.institutionIds, value.accountIds]);

  // Keep refs in sync with drafts after commit so the pointerdown handler
  // (which closes the open menu) reads the latest selection. Writing refs
  // during render is not allowed by react-hooks/refs.
  useEffect(() => {
    draftUserIdsRef.current = draftUserIds;
    draftInstitutionIdsRef.current = draftInstitutionIds;
    draftAccountIdsRef.current = draftAccountIds;
  }, [draftUserIds, draftInstitutionIds, draftAccountIds]);

  const validAccounts = useMemo(() => allAccounts.filter((account) => account.name.trim() && account.name.trim() !== "未指定账户"), [allAccounts]);
  const userFilteredAccounts = useMemo(() => validAccounts.filter((account) =>
    userIds.length === 0 || (account.groupId && userIds.includes(account.groupId)),
  ), [validAccounts, userIds]);
  const institutionOptions = useMemo(() => {
    const ids = new Set(userFilteredAccounts.map((account) => account.Institution?.id).filter(Boolean));
    const options = (allInstitutions.length > 0 ? allInstitutions : Array.from(new Map(validAccounts.filter((a) => a.Institution?.id).map((a) => [a.Institution!.id!, { id: a.Institution!.id!, name: a.Institution!.name, type: null }])).values())).filter((institution) => ids.has(institution.id));
    if (userFilteredAccounts.some((account) => !account.Institution?.id)) options.push({ id: CASH_INSTITUTION_ID, name: t("statistics.cashInstitution"), type: "cash" });
    return options;
  }, [validAccounts, allInstitutions, userFilteredAccounts, t]);
  const accountOptions = useMemo(() => [...userFilteredAccounts.filter((account) =>
    institutionIds.length === 0 || institutionIds.some((id) => id === (account.Institution?.id ?? CASH_INSTITUTION_ID)),
  )].sort((left, right) => {
    const institutionCompare = (left.Institution?.name ?? "").localeCompare(right.Institution?.name ?? "", "zh-CN");
    if (institutionCompare !== 0) return institutionCompare;
    return (left.label ?? left.name).localeCompare(right.label ?? right.name, "zh-CN");
  }), [userFilteredAccounts, institutionIds]);
  const userOptions = allUsers;

  useEffect(() => {
    if (!openMenu) return;
    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || menuAnchorRef.current?.contains(target)) return;
      const currentMenu = openMenu;
      const nextUserIds = draftUserIdsRef.current;
      const nextInstitutionIds = draftInstitutionIdsRef.current;
      const nextAccountIds = draftAccountIdsRef.current;
      if (currentMenu === "users") onChange({ userIds: nextUserIds, institutionIds, accountIds });
      if (currentMenu === "institutions") onChange({ userIds, institutionIds: nextInstitutionIds, accountIds });
      if (currentMenu === "accounts") onChange({ userIds, institutionIds, accountIds: nextAccountIds });
      setOpenMenu(null);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  // The handler intentionally reads the current draft selection when the menu closes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openMenu]);

  function selectSingle(kind: "users" | "institutions" | "accounts", id: string) {
    if (kind === "users") {
      const validAccountIds = accountIds.filter((accountIdValue) => allAccounts.some((account) => account.id === accountIdValue && account.groupId === id));
      setDraftUserIds([id]);
      setDraftAccountIds(validAccountIds);
      setOpenMenu(null);
      onChange({ userIds: [id], institutionIds, accountIds: validAccountIds });
    }
    if (kind === "institutions") {
      const validAccountIds = accountIds.filter((accountIdValue) => validAccounts.some((account) => account.id === accountIdValue && account.Institution?.id === id));
      setDraftInstitutionIds([id]);
      setDraftAccountIds(validAccountIds);
      setOpenMenu(null);
      onChange({ userIds, institutionIds: [id], accountIds: validAccountIds });
    }
    if (kind === "accounts") {
      setDraftAccountIds([id]);
      setOpenMenu(null);
      onChange({ userIds, institutionIds, accountIds: [id] });
    }
  }

  function confirm(kind: "users" | "institutions" | "accounts") {
    if (kind === "users") {
      const valid = draftAccountIds.filter((id) => allAccounts.some((account) => account.id === id && (draftUserIds.length === 0 || (account.groupId && draftUserIds.includes(account.groupId))) && (institutionIds.length === 0 || institutionIds.includes(account.Institution?.id ?? ""))));
      setDraftAccountIds(valid);
      setOpenMenu(null);
      onChange({ userIds: draftUserIds, institutionIds, accountIds: valid });
    }
    if (kind === "institutions") {
      const next = draftInstitutionIds;
      const nextAccount = draftAccountIds.filter((id) => allAccounts.some((account) =>
        account.id === id && (next.length === 0 || next.includes(account.Institution?.id ?? "")) && (userIds.length === 0 || (account.groupId && userIds.includes(account.groupId))),
      ));
      setDraftAccountIds(nextAccount);
      setOpenMenu(null);
      onChange({ userIds, institutionIds: next, accountIds: nextAccount });
    }
    if (kind === "accounts") {
      setOpenMenu(null);
      onChange({ userIds, institutionIds, accountIds: draftAccountIds });
    }
  }

  function toggleDraft(kind: "users" | "institutions" | "accounts", id: string) {
    const setter = kind === "users" ? setDraftUserIds : kind === "institutions" ? setDraftInstitutionIds : setDraftAccountIds;
    setter((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  }

  function toggleInstitutionType(type: string) {
    const ids = institutionOptions.filter((institution) => institutionGroupKey(institution.type) === type).map((institution) => institution.id);
    setDraftInstitutionIds((current) => ids.every((id) => current.includes(id))
      ? current.filter((id) => !ids.includes(id))
      : [...new Set([...current, ...ids])]);
  }

  function toggleAccountType(type: string) {
    const ids = accountOptions.filter((account) => account.kind === type).map((account) => account.id);
    setDraftAccountIds((current) => ids.every((id) => current.includes(id)) ? current.filter((id) => !ids.includes(id)) : [...new Set([...current, ...ids])]);
  }

  function clearSelection(kind: "users" | "institutions" | "accounts") {
    if (kind === "users") { setDraftUserIds([]); setOpenMenu(null); onChange({ userIds: [], institutionIds, accountIds }); }
    if (kind === "institutions") { setDraftInstitutionIds([]); setOpenMenu(null); onChange({ userIds, institutionIds: [], accountIds }); }
    if (kind === "accounts") { setDraftAccountIds([]); setOpenMenu(null); onChange({ userIds, institutionIds, accountIds: [] }); }
  }

  function institutionGroupKey(type: string | null | undefined) {
    if (type === "cash") return "cash";
    if (type === "bank") return "bank";
    if (type === "payment" || type === "ewallet") return "payment";
    if (type === "brokerage" || type === "investment") return "investment";
    return "other";
  }

  function institutionGroupLabel(type: string) {
    if (type === "cash") return t("statistics.cashInstitution");
    if (type === "bank") return t("institution.type.bank");
    if (type === "payment") return t("institution.type.payment");
    if (type === "investment") return t("statistics.investmentInstitutions");
    return t("institution.type.other");
  }

  function toggleMenu(kind: "users" | "institutions" | "accounts", button: HTMLButtonElement) {
    if (openMenu === kind) {
      confirm(kind);
      return;
    }
    const rect = button.getBoundingClientRect();
    menuAnchorRef.current = button;
    setMenuPosition({ left: rect.left, top: rect.bottom + 4 });
    setOpenMenu(kind);
  }

  function selectionLabel(kind: "users" | "institutions" | "accounts", selected: string[]) {
    if (selected.length === 0) {
      return kind === "users" ? t("statistics.allPeople") : kind === "institutions" ? t("statistics.allInstitutions") : t("reports.allAccounts");
    }
    const labels = selected.map((id) => {
      if (kind === "users") return allUsers.find((user) => user.id === id)?.name ?? id;
      if (kind === "institutions") return institutionOptions.find((institution) => institution.id === id)?.name ?? id;
      const account = allAccounts.find((item) => item.id === id);
      return accountLabel(account);
    });
    if ((kind === "institutions" || kind === "accounts") && labels.length > 1) {
      const key = kind === "institutions" ? "statistics.selectedInstitutionsSummary" : "statistics.selectedAccountsSummary";
      return t(key, { first: labels[0], count: labels.length });
    }
    return labels.join(", ");
  }

  function accountLabel(account: StatisticsAccountItem | StatisticsUserItem | undefined) {
    if (!account) return "";
    if (!('Institution' in account)) return account.name;
    return account.Institution?.name ? `${account.Institution.name}·${account.name}` : account.name;
  }

  return (
    <div className="flex min-w-max items-center gap-3">
      {(["users", "institutions", "accounts"] as const).map((kind) => {
        const isUsers = kind === "users";
        const isInstitutions = kind === "institutions";
        const selected = isUsers ? userIds : isInstitutions ? institutionIds : accountIds;
        const draft = isUsers ? draftUserIds : isInstitutions ? draftInstitutionIds : draftAccountIds;
        const items = isUsers ? userOptions : isInstitutions ? institutionOptions : accountOptions;
        return <div key={kind} className="relative shrink-0">
          <button type="button" title={selectionLabel(kind, selected)} aria-haspopup="listbox" aria-expanded={openMenu === kind} className="inline-flex h-8 min-w-40 max-w-56 items-center justify-between gap-2 rounded-md border border-slate-300 bg-white px-2.5 text-left text-xs text-slate-700 shadow-sm hover:border-slate-400" onClick={(event) => toggleMenu(kind, event.currentTarget)}>
            <span className="truncate">{selectionLabel(kind, selected)}</span>
            <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${openMenu === kind ? "rotate-180" : ""}`} />
          </button>
          {openMenu === kind && <div ref={menuRef} style={{ left: menuPosition.left, top: menuPosition.top }} className={`fixed z-[100] max-h-[min(70vh,520px)] overflow-y-auto rounded-md ${isInstitutions || !isUsers ? "w-[620px]" : "w-56"} border border-slate-200 bg-white p-2 shadow-lg`}>
            <div className="mb-1 px-2 text-[11px] font-medium text-slate-500">{isUsers ? t("statistics.allPeople") : isInstitutions ? t("statistics.allInstitutions") : t("reports.allAccounts")}</div>
            <button type="button" className="absolute right-2 top-2 text-[11px] text-blue-600 hover:text-blue-800" onClick={() => clearSelection(kind)}>{t("statistics.clearSelection")}</button>
            {items.length === 0 && <div className="px-2 py-2 text-xs text-slate-400">{t("table.empty")}</div>}
            {isInstitutions ? Array.from(new Set(institutionOptions.map((institution) => institutionGroupKey(institution.type)))).map((type) => { const groupedItems = institutionOptions.filter((institution) => institutionGroupKey(institution.type) === type); return <div key={type} className="grid grid-cols-[96px_1fr] items-start gap-2 border-b border-slate-200 py-2 last:border-b-0"><label className="flex min-h-7 items-center gap-1.5 px-2 text-xs font-medium text-slate-600"><input type="checkbox" checked={groupedItems.every((institution) => draftInstitutionIds.includes(institution.id))} onChange={() => toggleInstitutionType(type)} />{institutionGroupLabel(type)}</label><div className="grid grid-cols-3 items-start gap-x-2 gap-y-1">{groupedItems.map((item) => <div key={item.id} className="flex min-h-7 min-w-0 items-center gap-1.5 rounded px-1 py-1 text-xs hover:bg-slate-50"><input type="checkbox" className="shrink-0" checked={draftInstitutionIds.includes(item.id)} onChange={() => toggleDraft("institutions", item.id)} /><button type="button" className="min-w-0 flex-1 truncate text-left" title={item.name} onClick={() => selectSingle("institutions", item.id)}>{item.name}</button></div>)}</div></div>; }) : !isUsers ? Array.from(new Set(accountOptions.map((account) => account.kind ?? "other"))).map((type) => { const groupedItems = accountOptions.filter((account) => (account.kind ?? "other") === type); return <div key={type} className="grid grid-cols-[96px_1fr] items-start gap-2 border-b border-slate-200 py-2 last:border-b-0"><label className="flex min-h-7 items-center gap-1.5 px-2 text-xs font-medium text-slate-600"><input type="checkbox" checked={groupedItems.every((account) => draftAccountIds.includes(account.id))} onChange={() => toggleAccountType(type)} />{t(`account.kind.${type}`)}</label><div className="grid grid-cols-3 items-start gap-x-2 gap-y-1">{groupedItems.map((item) => <div key={item.id} className="flex min-h-7 min-w-0 items-center gap-1.5 rounded px-1 py-1 text-xs hover:bg-slate-50"><input type="checkbox" className="shrink-0" checked={draftAccountIds.includes(item.id)} onChange={() => toggleDraft("accounts", item.id)} /><button type="button" className="min-w-0 flex-1 truncate text-left" title={accountLabel(item)} onClick={() => selectSingle("accounts", item.id)}>{accountLabel(item)}</button></div>)}</div></div>; }) : items.map((item) => <div key={item.id} className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-slate-50">
              <input type="checkbox" checked={draft.includes(item.id)} onChange={() => toggleDraft(kind, item.id)} />
              <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => selectSingle(kind, item.id)}>{isUsers ? (allUsers.find((user) => user.id === item.id)?.name ?? item.id) : isInstitutions ? (institutionOptions.find((institution) => institution.id === item.id)?.name ?? item.id) : accountLabel(accountOptions.find((account) => account.id === item.id))}</button>
            </div>)}
            <div className="sticky bottom-0 mt-1 border-t border-slate-200 bg-white pt-1.5">
              <button type="button" className="h-7 w-full rounded bg-slate-900 px-3 text-xs font-medium text-white hover:bg-slate-700" onClick={() => confirm(kind)}>{t("table.confirm")}</button>
            </div>
          </div>}
        </div>;
      })}
    </div>
  );
}
