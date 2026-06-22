"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { X, Plus, Trash2, Database, TrendingUp } from "lucide-react";
import { SmartSelect, type SmartSelectOption } from "./SmartSelect";
import { NestedAddModal } from "./EntityCreateForm";
import { kindLabel } from "@/lib/account-kinds";

/* Types */

type AccountOption = { id: string; label: string; kind: string };
type EntityOption = { id: string; name: string; type?: string };
type CashAccountOption = { id: string; label: string };

type AccountBalanceRow = {
  tempId: string;
  accountId: string;
  label: string;
  kind: string;
  balance: string;
  date: string;
};

type FundHoldingRow = {
  tempId: string;
  investmentAccountId: string;
  investmentAccountLabel: string;
  fundCode: string;
  lastLookupFundCode: string;
  fundName: string;
  fundNav: string;
  fundNavDate: string;
  units: string;
  avgCost: string;
  lastBuyDate: string;
  arrivalDate: string;
  historicalProfit: string;
  cashAccountId: string;
  hasRegularInvest: boolean;
  riAmount: string;
  riIntervalUnit: string;
  riIntervalValue: string;
  riWeekday: string;
  riCashAccountId: string;
  riTxDate: string;
  riConfirmDate: string;
  riTPlusN: string;
  riArrivalDate: string;
  riFeeRate: string;
};

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export function InitModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [tab, setTab] = useState<"balance" | "fund">("balance");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string; details?: string[] } | null>(null);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [allAccounts, setAllAccounts] = useState<AccountOption[]>([]);
  const [accountGroups, setAccountGroups] = useState<EntityOption[]>([]);
  const [institutions, setInstitutions] = useState<EntityOption[]>([]);
  const [cashAccountList, setCashAccountList] = useState<CashAccountOption[]>([]);
  const [investmentAccountList, setInvestmentAccountList] = useState<AccountOption[]>([]);
  const [investSSOptions, setInvestSSOptions] = useState<SmartSelectOption[]>([]);
  const [cashSSOptions, setCashSSOptions] = useState<SmartSelectOption[]>([]);
  const [balanceRows, setBalanceRows] = useState<AccountBalanceRow[]>([]);
  const [fundRows, setFundRows] = useState<FundHoldingRow[]>([]);
  const [activeInvestAccountIds, setActiveInvestAccountIds] = useState<string[]>([]);
  const [currentInvestAccountId, setCurrentInvestAccountId] = useState("");
  const [addInvestAccountId, setAddInvestAccountId] = useState("");
  const [investNestedOpen, setInvestNestedOpen] = useState(false);
  const [balanceNestedOpen, setBalanceNestedOpen] = useState(false);
  const pendingInvestCreateFromAccountId = useRef("");
  const pendingBalanceCreateRowId = useRef("");
  const tempIdCounter = useRef(0);

  function rebuildSSOptions(accounts: AccountOption[], investAccounts: AccountOption[]) {
    setCashSSOptions(accounts.filter((a) => ["cash", "bank_debit", "ewallet"].includes(a.kind)).map((a) => ({ id: a.id, label: a.label, subLabel: kindLabel(a.kind) })));
    setInvestSSOptions(investAccounts.map((a) => ({ id: a.id, label: a.label, subLabel: kindLabel(a.kind) })));
  }

  async function fetchAccounts() {
    setLoadingAccounts(true);
    try {
      const res = await fetch("/api/v1/accounts/internal?balances=false");
      const data = await res.json();
      if (data.ok && data.accounts) {
        const accounts: AccountOption[] = data.accounts.map((a: any) => ({ id: a.id, label: (a.Institution?.name?.trim() || "") + (a.Institution?.name?.trim() ? "·" : "") + a.name, kind: a.kind }));
        const cashAccounts = accounts.filter((a) => ["cash", "bank_debit", "ewallet"].includes(a.kind));
        const investAccounts = accounts.filter((a) => a.kind === "investment");
        setAllAccounts(accounts);
        setAccountGroups((data.groups ?? []).map((g: any) => ({ id: g.id, name: g.name })));
        setInstitutions((data.institutions ?? []).map((it: any) => ({ id: it.id, name: it.name, type: it.type ?? undefined })));
        setCashAccountList(cashAccounts.map((a) => ({ id: a.id, label: a.label })));
        setInvestmentAccountList(investAccounts);
        rebuildSSOptions(accounts, investAccounts);
        setBalanceRows((prev) => prev);
        setActiveInvestAccountIds((prev) => prev.length > 0 ? prev : (investAccounts[0]?.id ? [investAccounts[0].id] : []));
        setCurrentInvestAccountId((prev) => prev || investAccounts[0]?.id || "");
      }
      setAccountsLoaded(true);
    } catch {
      setAccountsLoaded(true);
    } finally {
      setLoadingAccounts(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    setMessage(null);
    setBusy(false);
    setTab("balance");
    if (!accountsLoaded) {
      fetchAccounts();
    }
  }, [open, accountsLoaded]);

  function createEmptyFundRow(defaultAcc?: AccountOption): FundHoldingRow {
    tempIdCounter.current += 1;
    const txDate = todayStr();
    const defaultArrival = new Date(`${txDate}T00:00:00`);
    defaultArrival.setDate(defaultArrival.getDate() + 2);
    const defaultArrivalStr = defaultArrival.toISOString().slice(0, 10);
    return {
      tempId: `new-${tempIdCounter.current}`,
      investmentAccountId: defaultAcc?.id ?? "",
      investmentAccountLabel: defaultAcc?.label ?? "",
      fundCode: "", lastLookupFundCode: "", fundName: "", fundNav: "", fundNavDate: "",
      units: "", avgCost: "", lastBuyDate: "",
      arrivalDate: todayStr(), historicalProfit: "", cashAccountId: "",
      hasRegularInvest: false, riAmount: "", riIntervalUnit: "month", riIntervalValue: "1", riWeekday: "1",
      riCashAccountId: cashAccountList[0]?.id ?? "", riTxDate: txDate,
      riConfirmDate: txDate, riTPlusN: "", riArrivalDate: defaultArrivalStr, riFeeRate: "",
    };
  }

  function addFundRow(investmentAccountId?: string) {
    const defaultAcc = investmentAccountList.find((a) => a.id === investmentAccountId) ?? investmentAccountList[0];
    setFundRows((prev) => [...prev, createEmptyFundRow(defaultAcc)]);
  }

  function createEmptyBalanceRow(): AccountBalanceRow {
    tempIdCounter.current += 1;
    return { tempId: `balance-${tempIdCounter.current}`, accountId: "", label: "", kind: "", balance: "", date: todayStr() };
  }

  function addBalanceRow() {
    setBalanceRows((prev) => [...prev, createEmptyBalanceRow()]);
  }

  function updateBalanceRow(tempId: string, upd: Partial<AccountBalanceRow>) {
    setBalanceRows((prev) => prev.map((row) => (row.tempId === tempId ? { ...row, ...upd } : row)));
  }

  function selectBalanceAccount(tempId: string, accountId: string) {
    if (!accountId) return;
    const target = allAccounts.find((account) => account.id === accountId && account.kind !== "investment");
    if (!target) return;
    setBalanceRows((prev) => prev.map((row) => (
      row.tempId === tempId
        ? { ...row, accountId: target.id, label: target.label, kind: target.kind }
        : row
    )));
  }

  function handleBalanceAccountCreated(id: string, name: string, extra?: { kind?: string }) {
    const kind = extra?.kind || "bank_debit";
    const newAcc: AccountOption = { id, label: name, kind };
    const updatedAllAccounts = [...allAccounts, newAcc];
    const updatedInvest = kind === "investment" ? [...investmentAccountList, newAcc] : investmentAccountList;
    setAllAccounts(updatedAllAccounts);
    setInvestmentAccountList(updatedInvest);
    rebuildSSOptions(updatedAllAccounts, updatedInvest);
    if (kind !== "investment") {
      const pendingRowId = pendingBalanceCreateRowId.current;
      setBalanceRows((prev) => (
        pendingRowId
          ? prev.map((row) => (row.tempId === pendingRowId ? { ...row, accountId: id, label: name, kind } : row))
          : [...prev, { tempId: `balance-created-${id}`, accountId: id, label: name, kind, balance: "", date: todayStr() }]
      ));
    }
    pendingBalanceCreateRowId.current = "";
    setBalanceNestedOpen(false);
  }

  function startInvestAccountInitFlow(account: AccountOption) {
    setActiveInvestAccountIds((prev) => (prev.includes(account.id) ? prev : [...prev, account.id]));
    setCurrentInvestAccountId(account.id);
    setAddInvestAccountId("");
    setFundRows((prev) => {
      if (prev.some((row) => row.investmentAccountId === account.id)) return prev;
      return [...prev, createEmptyFundRow(account)];
    });
  }

  function removeFundRow(tempId: string) {
    setFundRows((prev) => prev.filter((r) => r.tempId !== tempId));
  }

  function removeInvestAccountFromInit(accountId: string) {
    if (activeInvestAccountIds.length <= 1) return;
    const nextIds = activeInvestAccountIds.filter((id) => id !== accountId);
    setActiveInvestAccountIds(nextIds);
    setCurrentInvestAccountId((prev) => (prev === accountId ? nextIds[0] ?? "" : prev));
    setFundRows((prev) => prev.filter((row) => row.investmentAccountId !== accountId));
    setAddInvestAccountId((prev) => (prev === accountId ? "" : prev));
  }

  function updateFundRow(tempId: string, upd: Partial<FundHoldingRow>) {
    setFundRows((prev) => prev.map((r) => (r.tempId === tempId ? { ...r, ...upd } : r)));
  }

  function fundRowHasContent(row: FundHoldingRow) {
    return Boolean(
      row.fundCode.trim() ||
      row.units.trim() ||
      row.avgCost.trim() ||
      row.historicalProfit.trim() ||
      row.hasRegularInvest
    );
  }

  function switchInvestAccountBlock(fromAccountId: string, toAccountId: string) {
    if (!toAccountId || fromAccountId === toAccountId) return;
    const target = investmentAccountList.find((account) => account.id === toAccountId);
    if (!target) return;
    const oldRows = fundRows.filter((row) => row.investmentAccountId === fromAccountId);
    if (oldRows.some(fundRowHasContent)) return;

    setActiveInvestAccountIds((prev) => {
      const next = prev.map((id) => (id === fromAccountId ? toAccountId : id));
      if (!next.includes(toAccountId)) next.push(toAccountId);
      return next.filter((id, index) => next.indexOf(id) === index);
    });
    setCurrentInvestAccountId(toAccountId);
    setFundRows((prev) => prev.map((row) => (
      row.investmentAccountId === fromAccountId
        ? { ...row, investmentAccountId: target.id, investmentAccountLabel: target.label }
        : row
    )));
  }

  function openInvestAccountCreate(fromAccountId?: string) {
    pendingInvestCreateFromAccountId.current = fromAccountId ?? "";
    setInvestNestedOpen(true);
  }

  function handleInvestAccountCreated(id: string, name: string) {
    const newAcc: AccountOption = { id, label: name, kind: "investment" };
    const updatedAllAccounts = [...allAccounts, newAcc];
    const updatedInvest = [...investmentAccountList, newAcc];
    setAllAccounts(updatedAllAccounts);
    setInvestmentAccountList(updatedInvest);
    rebuildSSOptions(updatedAllAccounts, updatedInvest);
    const fromAccountId = pendingInvestCreateFromAccountId.current;
    const oldRows = fromAccountId ? fundRows.filter((row) => row.investmentAccountId === fromAccountId) : [];
    if (fromAccountId && !oldRows.some(fundRowHasContent)) {
      setActiveInvestAccountIds((prev) => {
        const next = prev.map((accountId) => (accountId === fromAccountId ? id : accountId));
        if (!next.includes(id)) next.push(id);
        return next.filter((accountId, index) => next.indexOf(accountId) === index);
      });
      setCurrentInvestAccountId(id);
      setAddInvestAccountId("");
      setFundRows((prev) => {
        const hasRows = prev.some((row) => row.investmentAccountId === fromAccountId);
        if (!hasRows) return [...prev, createEmptyFundRow(newAcc)];
        return prev.map((row) => (
          row.investmentAccountId === fromAccountId
            ? { ...row, investmentAccountId: id, investmentAccountLabel: name }
            : row
        ));
      });
    } else {
      startInvestAccountInitFlow(newAcc);
    }
    pendingInvestCreateFromAccountId.current = "";
    setInvestNestedOpen(false);
  }

  function addInvestAccountToInit(accountId: string) {
    if (!accountId) return;
    const target = investmentAccountList.find((account) => account.id === accountId);
    if (!target) return;
    startInvestAccountInitFlow(target);
  }

  async function handleSubmit() {
    setBusy(true); setMessage(null);
    try {
      const accountBalances = balanceRows.filter((r) => r.accountId && r.balance.trim() && parseFloat(r.balance) !== 0).map((r) => ({ accountId: r.accountId, balance: parseFloat(r.balance), date: r.date || todayStr() }));
      const duplicateFundMap = new Map<string, string[]>();
      for (const row of fundRows) {
        const fundCode = row.fundCode.trim();
        const investmentAccountId = row.investmentAccountId || currentInvestAccountId;
        if (!fundCode || !investmentAccountId) continue;
        const key = `${investmentAccountId}::${fundCode}`;
        const labels = duplicateFundMap.get(key) ?? [];
        labels.push(row.investmentAccountLabel || fundCode);
        duplicateFundMap.set(key, labels);
      }
      const duplicateKeys = [...duplicateFundMap.entries()].filter(([, labels]) => labels.length > 1).map(([key]) => key);
      if (duplicateKeys.length > 0) {
        const duplicateDetails = duplicateKeys.map((key) => {
          const [investmentAccountId, fundCode] = key.split("::");
          const accountLabel = investmentAccountList.find((account) => account.id === investmentAccountId)?.label ?? "未命名投资账户";
          return `${accountLabel} 下的基金 ${fundCode} 重复录入`;
        });
        setMessage({ ok: false, text: "同一投资账户下不能重复录入同一基金", details: duplicateDetails });
        setBusy(false);
        return;
      }
      const fundHoldings = fundRows.filter((r) => r.fundCode.trim()).map((r) => ({
        fundCode: r.fundCode.trim(),
        units: parseFloat(r.units) || 0,
        avgCost: parseFloat(r.avgCost) || 0,
        lastBuyDate: r.lastBuyDate || undefined,
        arrivalDate: r.arrivalDate || undefined,
        historicalProfit: parseFloat(r.historicalProfit) || 0,
        investmentAccountId: r.investmentAccountId || currentInvestAccountId,
        cashAccountId: r.cashAccountId || undefined,
        regularInvest: r.hasRegularInvest ? {
          amount: parseFloat(r.riAmount) || 0, intervalUnit: r.riIntervalUnit, intervalValue: parseInt(r.riIntervalValue) || 1,
          cashAccountId: r.riCashAccountId, txDate: r.riTxDate || undefined, confirmDate: r.riConfirmDate || undefined,
          tPlusN: r.riConfirmDate && r.riTxDate ? Math.max(0, Math.round((new Date(r.riConfirmDate).getTime() - new Date(r.riTxDate).getTime()) / 86400000)) : undefined,
          arrivalDate: r.riArrivalDate || undefined, feeRate: r.riFeeRate ? parseFloat(r.riFeeRate) : undefined,
        } : undefined,
      })).filter((r) => r.units > 0 && r.avgCost > 0);
      if (accountBalances.length === 0 && fundHoldings.length === 0) {
        setMessage({ ok: false, text: "请填写至少一条记录" }); setBusy(false); return;
      }
      const res = await fetch("/api/v1/init", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountBalances, fundHoldings }) });
      const data = await res.json();
      if (!data.ok) setMessage({ ok: false, text: data.error ?? "初始化失败" });
      else { setMessage({ ok: true, text: data.message, details: data.details }); window.dispatchEvent(new Event("mmh:fund:refresh")); }
    } catch (e) { setMessage({ ok: false, text: e instanceof Error ? e.message : "初始化失败" }); }
    finally { setBusy(false); }
  }

  const activeInvestmentAccounts = useMemo(
    () => investmentAccountList.filter((account) => activeInvestAccountIds.includes(account.id)),
    [investmentAccountList, activeInvestAccountIds],
  );

  async function fillFundRowFromCode(tempId: string, accountId: string, rawCode: string) {
    const fundCode = rawCode.trim();
    const currentRow = fundRows.find((row) => row.tempId === tempId);
    if (currentRow?.lastLookupFundCode === fundCode) return;
    if (!/^\d{6}$/.test(fundCode)) {
      updateFundRow(tempId, { fundCode: rawCode, lastLookupFundCode: "", fundName: "", fundNav: "", fundNavDate: "" });
      return;
    }

    updateFundRow(tempId, { fundCode: rawCode, fundName: "", fundNav: "", fundNavDate: "" });

    try {
      const [nameRes, positionRes] = await Promise.allSettled([
        fetch(`/api/v1/fund/name?code=${fundCode}`).then((r) => r.json()),
        accountId
          ? fetch(`/api/v1/fund/position?accountId=${encodeURIComponent(accountId)}&fundCode=${encodeURIComponent(fundCode)}`).then((r) => r.json())
          : Promise.resolve({ ok: false, error: "缺少投资账户" }),
      ]);

      const nextPatch: Partial<FundHoldingRow> = {};

      if (nameRes.status === "fulfilled" && nameRes.value?.ok) {
        nextPatch.fundName = nameRes.value.name ?? "";
        nextPatch.fundNav = nameRes.value.nav == null ? "" : String(nameRes.value.nav);
        nextPatch.fundNavDate = nameRes.value.navDate ?? "";
      }

      if (positionRes.status === "fulfilled" && positionRes.value?.ok) {
        nextPatch.fundName = nextPatch.fundName || positionRes.value.fundName || "";
        nextPatch.avgCost = positionRes.value.avgCost == null ? "" : String(positionRes.value.avgCost);
        nextPatch.units = positionRes.value.units == null ? "" : String(positionRes.value.units);
        nextPatch.historicalProfit = positionRes.value.historicalProfit == null ? "" : String(positionRes.value.historicalProfit);
        if (!nextPatch.fundNav && positionRes.value.nav != null && Number(positionRes.value.nav) > 0) {
          nextPatch.fundNav = String(positionRes.value.nav);
        }
      }

      updateFundRow(tempId, { ...nextPatch, lastLookupFundCode: fundCode });
    } catch {
      // ignore lookup failure, keep manual editing available
    }
  }

  const addableInvestSSOptions = useMemo(
    () => investSSOptions.filter((option) => !activeInvestAccountIds.includes(option.id)),
    [investSSOptions, activeInvestAccountIds],
  );

  const balanceAccountSSOptions = useMemo(
    () => allAccounts
      .filter((account) => account.kind !== "investment")
      .map((account) => ({ id: account.id, label: account.label, subLabel: kindLabel(account.kind) })),
    [allAccounts],
  );

  const currentFundRows = useMemo(
    () => fundRows.filter((row) => row.investmentAccountId === currentInvestAccountId),
    [fundRows, currentInvestAccountId],
  );

  const canAddAnotherInvestAccount = useMemo(
    () => currentFundRows.some(fundRowHasContent),
    [currentFundRows],
  );

  function getBalanceAccountSSOptions(row: AccountBalanceRow) {
    return balanceAccountSSOptions.filter((option) => (
      option.id === row.accountId ||
      !balanceRows.some((other) => other.tempId !== row.tempId && other.accountId === option.id)
    ));
  }

  function handleClose() { if (!busy) onOpenChange(false); }

  if (!open) return null;

  return (
    <>
    {typeof document !== "undefined" && createPortal(
    <>
    <style>{`.init-modal-dropdown .smartselect-dropdown { z-index: 9999 !important; }
      .init-modal-number::-webkit-outer-spin-button,
      .init-modal-number::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
      .init-modal-number { appearance: textfield; -moz-appearance: textfield; }`}</style>
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/35 p-4 pt-[5vh] overflow-auto">
      <div className="w-full max-w-6xl rounded-xl bg-white border border-slate-200 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="shrink-0 px-5 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
          <div className="text-base font-bold text-slate-800">📦 初始数据</div>
          <button onClick={handleClose} disabled={busy} className="h-8 w-8 rounded-md border border-slate-200 bg-white flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-100 disabled:opacity-40"><X className="w-4 h-4" /></button>
        </div>
        <div className="shrink-0 flex border-b border-slate-200 bg-slate-50/50">
          <button onClick={() => { setTab("balance"); setMessage(null); }} className={`flex items-center gap-1.5 px-5 py-2.5 text-sm font-medium border-b-2 transition-colors ${tab === "balance" ? "border-blue-600 text-blue-700 bg-white" : "border-transparent text-slate-500 hover:text-slate-700"}`}><Database className="w-4 h-4" />账户余额</button>
          <button onClick={() => { setTab("fund"); setMessage(null); }} className={`flex items-center gap-1.5 px-5 py-2.5 text-sm font-medium border-b-2 transition-colors ${tab === "fund" ? "border-blue-600 text-blue-700 bg-white" : "border-transparent text-slate-500 hover:text-slate-700"}`}><TrendingUp className="w-4 h-4" />基金持仓</button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {tab === "balance" && (
            <div className="space-y-3">
              <div className="init-balance-toolbar flex items-center justify-between gap-3">
                <p className="text-xs text-slate-500">填写需要初始化余额的账户。选择账户并填写余额后，可继续添加下一个账户。</p>
                <button onClick={addBalanceRow} className="inline-flex items-center gap-1 h-8 px-3 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 shrink-0"><Plus className="w-4 h-4" />新增账户</button>
              </div>
              {loadingAccounts && !accountsLoaded ? <p className="text-sm text-slate-400 py-6 text-center">正在加载账户...</p> : balanceRows.length === 0 ? <p className="text-sm text-slate-400 py-6 text-center">暂无账户</p> : (
                <table className="w-full border-separate border-spacing-0">
                  <thead><tr className="text-xs font-semibold text-slate-600">
                    <th className="text-left px-3 py-2 border-b border-slate-200">账户</th>
                    <th className="text-left px-3 py-2 border-b border-slate-200">类型</th>
                    <th className="text-right px-3 py-2 border-b border-slate-200">初始余额</th>
                    <th className="text-left px-3 py-2 border-b border-slate-200">日期</th>
                  </tr></thead>
                  <tbody>{balanceRows.map((row) => {
                    const kl = row.kind ? (row.kind === "bank_debit" ? "借记卡" : row.kind === "bank_credit" ? "信用卡" : row.kind === "cash" ? "现金" : row.kind === "loan" ? "贷款" : row.kind === "ewallet" ? "电子钱包" : row.kind) : "";
                    const accountOptions = getBalanceAccountSSOptions(row);
                    return (<tr key={row.tempId} className="hover:bg-slate-50">
                      <td className="px-3 py-1.5 border-b border-slate-100 text-sm text-slate-700">
                        <div className="init-modal-dropdown min-w-[220px]">
                          <SmartSelect mode="single" value={row.accountId} onChange={(id) => selectBalanceAccount(row.tempId, id)} options={accountOptions} placeholder={accountOptions.length > 0 ? "选择资金账户" : "没有可选账户，可直接新建"} searchable={true} onCreateClick={() => { pendingBalanceCreateRowId.current = row.tempId; setBalanceNestedOpen(true); }} createLabel="新增" />
                        </div>
                      </td>
                      <td className="px-3 py-1.5 border-b border-slate-100 text-xs text-slate-500">{kl}</td>
                      <td className="px-3 py-1.5 border-b border-slate-100 text-right">
                        <input type="number" step="0.01" placeholder="0" value={row.balance} onChange={(e) => updateBalanceRow(row.tempId, { balance: e.target.value })} className="init-modal-number h-8 w-32 text-right rounded border border-slate-200 bg-white px-2 text-sm outline-none focus:border-blue-400" />
                      </td>
                      <td className="px-3 py-1.5 border-b border-slate-100">
                        <input type="date" value={row.date} onChange={(e) => updateBalanceRow(row.tempId, { date: e.target.value })} className="h-8 rounded border border-slate-200 bg-white px-2 text-sm outline-none focus:border-blue-400" />
                      </td>
                    </tr>);
                  })}</tbody>
                </table>
              )}
            </div>
          )}

          {tab === "fund" && (
            <div className="space-y-3">
              <p className="text-xs text-slate-500">选择投资账户，然后添加该账户下的基金持仓。系统将自动获取基金名称和最新净值。</p>
              {loadingAccounts && !accountsLoaded && (
                <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-sm text-slate-500 text-center">正在加载投资账户...</div>
              )}
              {investmentAccountList.length === 0 && !loadingAccounts && (
                <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-5 space-y-3">
                  <p className="text-sm text-slate-500 text-center">暂无投资账户，可直接在下方选择器中新建</p>
                  <div className="init-modal-dropdown max-w-sm mx-auto">
                    <SmartSelect mode="single" value={addInvestAccountId} onChange={(id) => { setAddInvestAccountId(id); addInvestAccountToInit(id); }} options={addableInvestSSOptions} placeholder="选择或新建投资账户" searchable={true} onCreateClick={() => openInvestAccountCreate()} createLabel="新增" />
                  </div>
                </div>
              )}
              {activeInvestmentAccounts.map((account) => {
                const accountFundRows = fundRows.filter((row) => row.investmentAccountId === account.id);
                const accountHasContent = accountFundRows.some(fundRowHasContent);
                const accountSwitchOptions = investSSOptions.filter((option) => option.id === account.id || !activeInvestAccountIds.includes(option.id));
                return (
              <div key={`invest-panel-${account.id}`} className="space-y-3">
              <div className="rounded-xl border border-slate-200 bg-white px-3 py-3">
              <div className="flex items-center gap-2">
                <label className="text-[10px] font-semibold text-slate-500 uppercase shrink-0">投资账户</label>
                <div className="init-modal-dropdown flex-1 max-w-xs" key={`invest-switch-${account.id}`}>
                  <SmartSelect mode="single" value={account.id} onChange={(id) => accountHasContent ? addInvestAccountToInit(id) : switchInvestAccountBlock(account.id, id)} options={accountSwitchOptions} placeholder="选择投资账户" searchable={true} onCreateClick={() => openInvestAccountCreate(account.id)} createLabel="新增" />
                </div>
                <button onClick={() => { setCurrentInvestAccountId(account.id); addFundRow(account.id); }} className="inline-flex items-center gap-1 h-8 px-3 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 shrink-0"><Plus className="w-4 h-4" />添加基金</button>
                {activeInvestmentAccounts.length > 1 && (
                  <button onClick={() => removeInvestAccountFromInit(account.id)} className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-red-200 bg-white text-red-500 hover:bg-red-50 shrink-0" title="移除投资账户">
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
              </div>
                {!loadingAccounts && accountFundRows.length === 0 && (
                  <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-sm text-slate-500 text-center">当前投资账户下还没有基金，点击上方“添加基金”开始录入。</div>
                )}
                {accountFundRows.length > 0 && (
                  <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
                  <div className="overflow-auto">
                    <table className="min-w-[640px] w-full table-fixed border-separate border-spacing-0">
                      <colgroup>
                        <col className="w-[186px]" />
                        <col className="w-[46px]" />
                        <col className="w-[46px]" />
                        <col className="w-[68px]" />
                        <col className="w-[60px]" />
                        <col className="w-[64px]" />
                        <col className="w-[64px]" />
                        <col className="w-[32px]" />
                        <col className="w-[32px]" />
                      </colgroup>
                      <thead className="sticky top-0 z-10 bg-white">
                        <tr>
                          <th className="px-2 py-1 border-b border-r border-slate-200 text-left text-xs font-semibold text-slate-600">基金</th>
                          <th className="px-1.5 py-1 border-b border-r border-slate-200 text-right text-xs font-semibold text-slate-600">均价</th>
                          <th className="px-1.5 py-1 border-b border-r border-slate-200 text-right text-xs font-semibold text-slate-600">份额</th>
                          <th className="px-1.5 py-1 border-b border-r border-slate-200 text-right text-xs font-semibold text-slate-600">净值</th>
                          <th className="px-1.5 py-1 border-b border-r border-slate-200 text-right text-xs font-semibold text-slate-600">市值</th>
                          <th className="px-1.5 py-1 border-b border-r border-slate-200 text-right text-xs font-semibold text-slate-600">浮盈</th>
                          <th className="px-1.5 py-1 border-b border-r border-slate-200 text-right text-xs font-semibold text-slate-600">历史盈亏</th>
                          <th className="px-0 py-1 border-b border-slate-200 text-center text-xs font-semibold text-slate-600">定投</th>
                          <th className="px-0 py-1 border-b border-slate-200 text-center text-xs font-semibold text-slate-600">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {accountFundRows.map((row) => {
                          const n = parseFloat(row.fundNav) || 0;
                          const u = parseFloat(row.units) || 0;
                          const a = parseFloat(row.avgCost) || 0;
                          const tc = u * a;
                          const mv = n > 0 ? u * n : 0;
                          const floatingProfit = n > 0 && u > 0 && a > 0 ? mv - tc : 0;
                          const floatingProfitClass = floatingProfit > 0 ? "text-emerald-600" : floatingProfit < 0 ? "text-red-600" : "text-slate-500";
                          const fundNameFontSize = row.fundName
                            ? Math.max(10, Math.min(13, 112 / Math.max(row.fundName.length, 1)))
                            : 12;

                          return (
                            <>
                              <tr key={row.tempId} className="hover:bg-slate-50 align-top">
                                <td className="px-2 py-1 border-b border-r border-slate-100 align-middle">
                                  <div className="flex items-start gap-1.5">
                                    <input type="text" placeholder="6位代码" maxLength={6} value={row.fundCode}
                                      onChange={(e) => {
                                        const code = e.target.value;
                                        updateFundRow(row.tempId, { fundCode: code });
                                      }}
                                      onBlur={(e) => {
                                        void fillFundRowFromCode(row.tempId, row.investmentAccountId || account.id, e.target.value);
                                      }}
                                      className="h-6 w-[78px] shrink-0 rounded-none border-0 border-b border-slate-200 bg-transparent px-0 text-[14px] font-medium font-mono text-center text-slate-800 outline-none focus:border-blue-400" />
                                    <div className="min-w-0 flex-1 pt-0.5 text-slate-700">
                                      <div className="truncate leading-5" style={{ fontSize: `${fundNameFontSize}px` }}>{row.fundName || "输入代码自动获取"}</div>
                                    </div>
                                  </div>
                                </td>
                                <td className="px-1.5 py-1 border-b border-r border-slate-100 align-middle text-right">
                                  <input type="number" step="0.0001" placeholder="0" value={row.avgCost} onChange={(e) => updateFundRow(row.tempId, { avgCost: e.target.value })} className="init-modal-number ml-auto block h-6 w-full rounded-none border-0 border-b border-slate-200 bg-transparent px-0 text-right text-[13px] font-medium leading-6 tabular-nums text-slate-800 outline-none focus:border-blue-400" />
                                </td>
                                <td className="px-1.5 py-1 border-b border-r border-slate-100 align-middle text-right">
                                  <input type="number" step="0.01" placeholder="0" value={row.units} onChange={(e) => updateFundRow(row.tempId, { units: e.target.value })} className="init-modal-number ml-auto block h-6 w-full rounded-none border-0 border-b border-slate-200 bg-transparent px-0 text-right text-[13px] font-medium leading-6 tabular-nums text-slate-800 outline-none focus:border-blue-400" />
                                </td>
                                <td className="px-1 py-1 border-b border-r border-slate-100 align-middle text-right tabular-nums text-slate-700">
                                  {n > 0 ? (
                                    <div className="flex items-baseline justify-end gap-1 leading-6">
                                      <span className="text-[13px] font-medium">{n.toFixed(4)}</span>
                                      {row.fundNavDate && <span className="text-[9px] font-normal leading-none text-slate-400">{row.fundNavDate.slice(5)}</span>}
                                    </div>
                                  ) : "--"}
                                </td>
                                <td className="px-1.5 py-1 border-b border-r border-slate-100 align-middle text-right text-[13px] leading-6 font-medium tabular-nums text-slate-800">
                                  {u > 0 && n > 0 ? mv.toFixed(2) : "--"}
                                </td>
                                <td className={`px-1.5 py-1 border-b border-r border-slate-100 align-middle text-right text-[13px] leading-6 font-medium tabular-nums ${floatingProfitClass}`}>
                                  {u > 0 && n > 0 && a > 0 ? `${floatingProfit >= 0 ? "+" : ""}${floatingProfit.toFixed(2)}` : "--"}
                                </td>
                                <td className="px-1.5 py-1 border-b border-r border-slate-100 align-middle">
                                  <input type="number" step="0.01" placeholder="0" value={row.historicalProfit} onChange={(e) => updateFundRow(row.tempId, { historicalProfit: e.target.value })} className="init-modal-number h-6 w-full rounded-none border-0 border-b border-slate-200 bg-transparent px-0 text-[13px] leading-6 font-medium tabular-nums text-right text-slate-800 outline-none focus:border-blue-400" />
                                </td>
                                <td className="px-0 py-1 border-b border-slate-100 align-top text-center">
                                  <label className="inline-flex h-6.5 w-5 items-center justify-center cursor-pointer">
                                    <input type="checkbox" checked={row.hasRegularInvest} onChange={(e) => updateFundRow(row.tempId, { hasRegularInvest: e.target.checked })} className="h-3.5 w-3.5 accent-blue-600" />
                                  </label>
                                </td>
                                <td className="px-0 py-1 border-b border-slate-100 align-top text-center">
                                  <button onClick={() => removeFundRow(row.tempId)} className="inline-flex h-5.5 w-5.5 items-center justify-center rounded border border-red-200 bg-white text-red-500 hover:bg-red-50" title="移除"><Trash2 className="w-3 h-3" /></button>
                                </td>
                              </tr>
                              {row.hasRegularInvest && (
                                <tr key={`${row.tempId}-ri`} className="bg-slate-50/70">
                                  <td colSpan={9} className="border-b border-slate-100 px-3 py-2">
                                    <div className="space-y-2">
                                      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">最近交易明细</p>
                                      <div className="overflow-x-auto">
                                        <div className="flex min-w-[802px] items-end gap-1.5">
                                          <div className="w-[148px] shrink-0 space-y-1"><label className="text-[11px] font-medium uppercase text-slate-500">扣款账户</label><SmartSelect mode="single" value={row.riCashAccountId} onChange={(id) => updateFundRow(row.tempId, { riCashAccountId: id })} options={cashSSOptions} placeholder="不限" /></div>
                                          <div className="w-[78px] shrink-0 space-y-1"><label className="text-[11px] font-medium uppercase text-slate-500">每期金额</label><input type="number" step="0.01" placeholder="金额" value={row.riAmount} onChange={(e) => updateFundRow(row.tempId, { riAmount: e.target.value })} className="init-modal-number h-7 w-full rounded-none border-0 border-b border-slate-200 bg-transparent px-0 text-[13px] font-medium text-right text-slate-800 outline-none focus:border-blue-400" /></div>
                                          <div className="w-[148px] shrink-0 space-y-1"><label className="text-[11px] font-medium uppercase text-slate-500">间隔</label>
                                            <div className="flex gap-1">
                                              <input type="number" min="1" placeholder="1" value={row.riIntervalValue} onChange={(e) => updateFundRow(row.tempId, { riIntervalValue: e.target.value })} className="h-7 w-9 rounded-none border-0 border-b border-slate-200 bg-transparent px-0 text-[13px] font-medium text-center text-slate-800 outline-none focus:border-blue-400" />
                                              <select value={row.riIntervalUnit} onChange={(e) => updateFundRow(row.tempId, { riIntervalUnit: e.target.value, riWeekday: e.target.value === "week" ? (row.riWeekday || "1") : row.riWeekday })} className="h-7 w-[54px] rounded-none border-0 border-b border-slate-200 bg-transparent px-0 text-[12px] text-slate-700 outline-none focus:border-blue-400"><option value="day">天</option><option value="week">周</option><option value="biweek">双周</option><option value="month">月</option></select>
                                              {row.riIntervalUnit === "week" && <select value={row.riWeekday} onChange={(e) => updateFundRow(row.tempId, { riWeekday: e.target.value })} className="h-7 w-[56px] rounded-none border-0 border-b border-slate-200 bg-transparent px-0 text-[12px] text-slate-700 outline-none focus:border-blue-400"><option value="1">周一</option><option value="2">周二</option><option value="3">周三</option><option value="4">周四</option><option value="5">周五</option><option value="6">周六</option><option value="0">周日</option></select>}
                                            </div>
                                          </div>
                                          <div className="w-[96px] shrink-0 space-y-1"><label className="text-[11px] font-medium uppercase text-slate-500">交易日</label>
                                            <input type="date" value={row.riTxDate} onChange={(e) => { const txDate = e.target.value; let tPlusN = ""; let arrivalDate = row.riArrivalDate; if (txDate && row.riConfirmDate) { const diff = Math.round((new Date(row.riConfirmDate).getTime() - new Date(txDate).getTime()) / 86400000); if (diff >= 0) tPlusN = String(diff); } if (txDate && (!row.riArrivalDate || row.riArrivalDate === row.riTxDate)) { const arrival = new Date(`${txDate}T00:00:00`); arrival.setDate(arrival.getDate() + 2); arrivalDate = arrival.toISOString().slice(0, 10); } updateFundRow(row.tempId, { riTxDate: txDate, riTPlusN: tPlusN, riArrivalDate: arrivalDate }); }} className="h-7 w-full rounded-none border-0 border-b border-slate-200 bg-transparent px-0 text-[12px] text-slate-800 outline-none focus:border-blue-400" />
                                          </div>
                                          <div className="w-[96px] shrink-0 space-y-1"><label className="text-[11px] font-medium uppercase text-slate-500">确认日</label>
                                            <input type="date" value={row.riConfirmDate} onChange={(e) => { const confirmDate = e.target.value; let tPlusN = ""; if (row.riTxDate && confirmDate) { const diff = Math.round((new Date(confirmDate).getTime() - new Date(row.riTxDate).getTime()) / 86400000); if (diff >= 0) tPlusN = String(diff); } updateFundRow(row.tempId, { riConfirmDate: confirmDate, riTPlusN: tPlusN }); }} className="h-7 w-full rounded-none border-0 border-b border-slate-200 bg-transparent px-0 text-[12px] text-slate-800 outline-none focus:border-blue-400" />
                                          </div>
                                          <div className="w-[96px] shrink-0 space-y-1"><label className="text-[11px] font-medium uppercase text-slate-500">入账日</label><input type="date" value={row.riArrivalDate} onChange={(e) => updateFundRow(row.tempId, { riArrivalDate: e.target.value })} className="h-7 w-full rounded-none border-0 border-b border-slate-200 bg-transparent px-0 text-[12px] text-slate-800 outline-none focus:border-blue-400" /></div>
                                          <div className="w-[60px] shrink-0 space-y-1"><label className="text-[11px] font-medium uppercase text-slate-500">费率%</label><input type="number" step="0.01" placeholder="0" value={row.riFeeRate} onChange={(e) => updateFundRow(row.tempId, { riFeeRate: e.target.value })} className="init-modal-number h-7 w-full rounded-none border-0 border-b border-slate-200 bg-transparent px-0 text-[13px] font-medium text-right text-slate-800 outline-none focus:border-blue-400" /></div>
                                        </div>
                                      </div>
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  </div>
                )}
              </div>
                );
              })}

              {investmentAccountList.length > 0 && canAddAnotherInvestAccount && (
                <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-3">
                  <p className="mb-2 text-[11px] font-medium text-slate-500">新增投资账户</p>
                  <div className="init-modal-dropdown">
                    <SmartSelect mode="single" value={addInvestAccountId} onChange={(id) => { setAddInvestAccountId(id); addInvestAccountToInit(id); }} options={addableInvestSSOptions} placeholder={addableInvestSSOptions.length > 0 ? "选择一个投资账户加入当前初始化" : "没有可选账户，可直接新建"} searchable={true} onCreateClick={() => openInvestAccountCreate()} createLabel="新增" />
                  </div>
                </div>
              )}
            </div>
          )}

          {message && (
            <div className={`rounded-lg px-4 py-3 text-sm ${message.ok ? "bg-emerald-50 text-emerald-700 border border-emerald-200" : "bg-red-50 text-red-700 border border-red-200"}`}>
              <p className="font-medium">{message.text}</p>
              {message.details && message.details.length > 0 && <ul className="mt-1 space-y-0.5">{message.details.map((d, i) => <li key={i} className="text-xs opacity-80">{d}</li>)}</ul>}
            </div>
          )}
        </div>

        <div className="shrink-0 px-5 py-3 border-t border-slate-200 bg-slate-50 flex items-center justify-between">
          <div className="text-xs text-slate-400">{tab === "balance" ? `共 ${balanceRows.length} 个账户` : `共 ${new Set(fundRows.map((row) => row.investmentAccountId).filter(Boolean)).size} 个投资账户，${fundRows.length} 只基金`}</div>
          <div className="flex items-center gap-2">
            <button onClick={handleClose} disabled={busy} className="h-9 px-4 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-40">取消</button>
            <button onClick={handleSubmit} disabled={busy} className="h-9 px-5 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1">
              {busy ? <><span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />处理中...</> : "保存"}
            </button>
          </div>
        </div>
      </div>
    </div>
    </>, document.body
    )}

    {open && investNestedOpen && createPortal(
      <NestedAddModal mode="compact" entityType="account" open={investNestedOpen}
        onClose={() => { pendingInvestCreateFromAccountId.current = ""; setInvestNestedOpen(false); }}
        onCreated={handleInvestAccountCreated}
        nestedFieldData={{ groupId: accountGroups, institutionId: institutions }}
        extraFields={{ kind: "investment", investProductType: "fund" }}
        hiddenFields={["kind", "investProductType"]}
      />, document.body
    )}

    {open && balanceNestedOpen && createPortal(
      <NestedAddModal mode="compact" entityType="account" open={balanceNestedOpen}
        onClose={() => { pendingBalanceCreateRowId.current = ""; setBalanceNestedOpen(false); }}
        onCreated={handleBalanceAccountCreated}
        nestedFieldData={{ groupId: accountGroups, institutionId: institutions }}
      />, document.body
    )}
    </>
  );
}
