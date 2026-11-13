"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

import { CalcInput } from "@/components/CalcInput";
import { DateStepper } from "@/components/DateStepper";
import { SmartSelect, type SmartSelectOption } from "@/components/SmartSelect";
import { getRepoOccupiedDaysModePreference } from "@/lib/client/appPreferences";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { formatAmountDraft, formatMoney } from "@/lib/format";
import { todayDateLocalYmd } from "@/lib/date-utils";
import { useI18n } from "@/lib/i18n";
import {
  estimateRepoInterest,
  estimateRepoMaturityDateKey,
  REPO_MARKET_LABEL,
  REPO_PRODUCTS,
  type RepoProduct,
  repoFeeRatePercent,
  repoOccupiedDays,
  repoProductByCode,
} from "@/lib/repo";

/**
 * 逆回购录入字段（只有一个动作：借出）。
 *
 * 逆回购已经并入股票视图：借出时成交价已经定死了回购利率与到期日，到期由
 * `autoRedeemDueRepos` 自动回款，所以这里没有「回款」页签，也不需要用户再确认一次。
 *
 * 品种跟股票一样是 6 位代码（204001 = GC001），直接输代码，下面带出品种与期限。
 */

export type RepoCashAccountOption = {
  id: string;
  label: string;
  title?: string | null;
  kind?: string | null;
  institutionId?: string | null;
};

export type RepoEntryFieldsHandle = {
  /** 由外层窗口的页脚「保存」按钮调用（回车提交同样走这里）。 */
  submit: () => Promise<void>;
};

type Props = {
  /** 逆回购归属的股票（证券）账户。 */
  accountId: string;
  accountLabel: string;
  /** 股票账户下拉（不传则只读显示 accountLabel）。 */
  accountOptions?: SmartSelectOption[];
  onAccountChange?: (accountId: string) => void;
  /** 券商机构，用于默认挑出该券商的资金账户。 */
  institutionId?: string | null;
  cashAccounts: RepoCashAccountOption[];
  /** 入口带来的默认资金账户（券商资金账户优先）。 */
  defaultCashAccountId?: string | null;
  /** 窗口每次重新打开时递增，用来丢掉上一次的草稿。 */
  resetKey: number;
  /** 下拉里的「新增账户」入口，复用外层窗口的建户表单。 */
  onCreateAccount?: () => void;
  createAccountLabel?: string;
  onCreateCashAccount?: () => void;
  createCashAccountLabel?: string;
  onSubmittingChange?: (submitting: boolean) => void;
  onSaved?: () => void;
};

const LAST_DRAFT_KEY = "mmh:repo:last-draft:v2";
const REPO_CODE_RE = /^\d{6}$/;

type CustomRepoProductRow = {
  id: string;
  code: string;
  name: string;
  market: string;
  termDays: number;
  feeRatePercent: number | null;
  note: string | null;
};

type LastDraft = { code: string; amount: string; annualRate: string; cashAccountId?: string };

function readLastDraft(): LastDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LAST_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LastDraft;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeLastDraft(draft: LastDraft) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    /* 忽略：草稿只是便利，不影响录入 */
  }
}

function num(value: string | number | null | undefined): number {
  const parsed = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

export const RepoEntryFields = forwardRef<RepoEntryFieldsHandle, Props>(function RepoEntryFields(
  {
    accountId,
    accountLabel,
    accountOptions,
    onAccountChange,
    institutionId,
    cashAccounts,
    defaultCashAccountId,
    resetKey,
    onCreateAccount,
    createAccountLabel,
    onCreateCashAccount,
    createCashAccountLabel,
    onSubmittingChange,
    onSaved,
  },
  ref,
) {
  const { t } = useI18n();
  const [submitting, setSubmitting] = useState(false);

  const [code, setCode] = useState("204001");
  const [amount, setAmount] = useState("");
  const [annualRate, setAnnualRate] = useState("");
  const [tradeDate, setTradeDate] = useState(todayDateLocalYmd());
  const [maturityDate, setMaturityDate] = useState("");
  const [fee, setFee] = useState("");
  const [cashAccountId, setCashAccountId] = useState("");
  const [note, setNote] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);

  // 自定义品种（交易所静态清单之外，按账簿持久化），随组件挂载加载一次。
  const [customProducts, setCustomProducts] = useState<CustomRepoProductRow[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");
  const [newMarket, setNewMarket] = useState<"sh" | "sz">("sh");
  const [newTermDays, setNewTermDays] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/v1/repo/custom-products")
      .then((res) => res.json().catch(() => null))
      .then((data: { ok?: boolean; products?: CustomRepoProductRow[] } | null) => {
        if (!cancelled && data?.ok) setCustomProducts(data.products ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const customAsProducts = useMemo<RepoProduct[]>(
    () =>
      customProducts.map((row) => ({
        code: row.code,
        name: row.name,
        market: row.market === "sz" ? "sz" : "sh",
        termDays: row.termDays,
        minAmount: 1000,
        stepAmount: 1000,
        feeRatePercent: row.feeRatePercent ?? repoFeeRatePercent(row.termDays),
      })),
    [customProducts],
  );

  const allProducts = useMemo<RepoProduct[]>(
    () => [...REPO_PRODUCTS, ...customAsProducts],
    [customAsProducts],
  );

  // 品种解析：先交易所清单，再自定义品种。
  const product = useMemo(
    () => repoProductByCode(code) ?? customAsProducts.find((item) => item.code === code) ?? null,
    [code, customAsProducts],
  );
  const termDays = product?.termDays ?? 1;

  const cashOptions = useMemo<SmartSelectOption[]>(
    () => cashAccounts.map((item) => ({
      id: item.id,
      label: item.label,
      title: item.title ?? undefined,
      kind: item.kind ?? null,
      institutionId: item.institutionId ?? null,
    })),
    [cashAccounts],
  );

  const codeMatches = useMemo(() => {
    const query = code.trim().toUpperCase();
    const rows = query
      ? allProducts.filter(
          (item) =>
            item.code.includes(query) || item.name.toUpperCase().includes(query),
        )
      : allProducts;
    return rows.slice(0, 8);
  }, [allProducts, code]);

  const pickDefaultCashAccount = useCallback(() => {
    const institution = String(institutionId ?? "").trim();
    const matched = institution
      ? cashAccounts.find(
          (item) => item.institutionId === institution && (item.kind === "cash" || item.kind === "ewallet"),
        )
      : undefined;
    return (
      // 入口显式带的资金账户优先（胶囊菜单已经按当前股票账户算出券商资金账户）。
      cashAccounts.find((item) => item.id === defaultCashAccountId)?.id
      ?? matched?.id
      ?? cashAccounts.find((item) => item.kind === "cash")?.id
      ?? cashAccounts.find((item) => item.kind === "ewallet")?.id
      ?? cashAccounts[0]?.id
      ?? ""
    );
  }, [cashAccounts, defaultCashAccountId, institutionId]);

  // 只在「窗口刚打开」时恢复默认值：路由刷新带来的新数组不能把用户正在填的内容冲掉。
  const appliedResetKeyRef = useRef<number | null>(null);
  useEffect(() => {
    if (appliedResetKeyRef.current === resetKey) return;
    appliedResetKeyRef.current = resetKey;
    const draft = readLastDraft();
    // 上次的品种可能是自定义品种（不在交易所清单），这里不做清单校验，由提交侧兜底。
    const nextCode = draft?.code?.trim() || "204001";
    setCode(nextCode);
    setAmount(draft?.amount ?? "");
    setAnnualRate(draft?.annualRate ?? "");
    setTradeDate(todayDateLocalYmd());
    setMaturityDate(
      estimateRepoMaturityDateKey(todayDateLocalYmd(), repoProductByCode(nextCode)?.termDays ?? 1),
    );
    setFee("");
    setNote("");
    setCreateOpen(false);
    setPickerOpen(false);
    setCashAccountId(
      draft?.cashAccountId && cashAccounts.some((item) => item.id === draft.cashAccountId)
        ? draft.cashAccountId
        : pickDefaultCashAccount(),
    );
  }, [resetKey, cashAccounts, pickDefaultCashAccount]);

  // 成交日或品种变化 → 到期日跟着重算（此后用户仍可手动改，改动日期不会再被覆盖）。
  useEffect(() => {
    setMaturityDate(estimateRepoMaturityDateKey(tradeDate, termDays));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tradeDate, code]);

  // 资金账户是异步取来的：落地后补一次默认值，不覆盖用户已选。
  useEffect(() => {
    if (cashAccountId && cashAccounts.some((item) => item.id === cashAccountId)) return;
    const next = pickDefaultCashAccount();
    if (next && next !== cashAccountId) setCashAccountId(next);
  }, [cashAccountId, cashAccounts, pickDefaultCashAccount]);

  // 占款口径跟着账簿设置走（cookie 镜像），与落账用同一份值。
  const occupiedDaysMode = getRepoOccupiedDaysModePreference();
  const occupiedDays = repoOccupiedDays(tradeDate, maturityDate, termDays, occupiedDaysMode);
  const principal = num(amount);
  const expectedInterest = estimateRepoInterest({
    principal,
    annualRate: num(annualRate) || null,
    occupiedDays,
  });
  // 手续费预览用品种费率（自定义品种可有自己的费率，不按交易所期限档）。
  const feeEstimate =
    principal > 0 ? Math.max(0.01, Number(((principal * (product?.feeRatePercent ?? 0)) / 100).toFixed(2))) : 0;
  const effectiveFee = fee === "" ? feeEstimate : num(fee);
  const arrivalPreview = Number((principal + expectedInterest - effectiveFee).toFixed(2));

  const submit = useCallback(async () => {
    if (submitting) return;
    if (!accountId) return window.alert(t("repoForm.alert.accountRequired"));
    if (!cashAccountId) return window.alert(t("repoForm.alert.cashRequired"));
    if (!REPO_CODE_RE.test(code.trim())) return window.alert(t("repoForm.alert.codeRequired"));
    if (!product) return window.alert(t("repoForm.alert.productRequired"));
    if (!(principal > 0)) return window.alert(t("repoForm.alert.amountRequired"));
    const occupiedMode = getRepoOccupiedDaysModePreference();
    if (!maturityDate || repoOccupiedDays(tradeDate, maturityDate, termDays, occupiedMode) <= 0) {
      return window.alert(t("repoForm.alert.maturityInvalid"));
    }

    setSubmitting(true);
    onSubmittingChange?.(true);
    try {
      const res = await fetch("/api/v1/repo/lend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          cashAccountId,
          date: tradeDate,
          code: code.trim(),
          amount: principal,
          annualRate: num(annualRate) || null,
          termDays,
          maturityDate,
          fee: fee === "" ? null : num(fee),
          note: note.trim() || undefined,
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string; cashEntryId?: string }
        | null;
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? t("repoForm.alert.saveFailed"));

      writeLastDraft({ code: code.trim(), amount, annualRate, cashAccountId });
      dispatchFinanceDataChanged({
        reason: "repo-lend",
        accountIds: [accountId, cashAccountId].filter(Boolean),
        entryIds: data?.cashEntryId ? [data.cashEntryId] : undefined,
      });
      onSaved?.();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t("repoForm.alert.saveFailed"));
    } finally {
      setSubmitting(false);
      onSubmittingChange?.(false);
    }
  }, [
    accountId, amount, annualRate, cashAccountId, code, fee, maturityDate, note,
    onSaved, onSubmittingChange, principal, product, submitting, t, termDays, tradeDate,
  ]);

  // 外层窗口页脚 / 回车提交都走这个句柄。
  useImperativeHandle(ref, () => ({ submit }), [submit]);

  // 股票账户字段：日期固定占第一格，账户紧随其后。
  const accountField = (
    <div className="space-y-1">
      <div className="form-label">{t("repoForm.stockAccount")}</div>
      {accountOptions && onAccountChange ? (
        <SmartSelect
          mode="single"
          value={accountId}
          onChange={onAccountChange}
          options={accountOptions}
          placeholder={t("repoForm.stockAccountPlaceholder")}
          onCreateClick={onCreateAccount}
          createLabel={createAccountLabel}
          behavior={{ search: true, density: "compact", minDropdownWidth: 260 }}
        />
      ) : (
        <div className="form-input flex items-center text-slate-600" title={accountLabel}>{accountLabel || "-"}</div>
      )}
    </div>
  );

  const codeField = (
    <div className="space-y-1">
      <div className="form-label">{t("repoForm.code")}</div>
      <div className="relative">
        <input
          value={code}
          onChange={(event) => {
            const next = event.target.value.replace(/\s/g, "").slice(0, 6);
            setCode(next);
            setPickerOpen(true);
          }}
          onFocus={() => setPickerOpen(true)}
          onBlur={() => window.setTimeout(() => setPickerOpen(false), 120)}
          className="form-input font-mono tabular-nums tracking-[0.08em]"
          placeholder={t("repoForm.codePlaceholder")}
          inputMode="numeric"
          maxLength={6}
          autoComplete="off"
          aria-label={t("repoForm.code")}
        />
        {pickerOpen && codeMatches.length > 0 ? (
          <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-64 overflow-auto rounded-md border border-slate-200 bg-white py-1 shadow-lg">
            {codeMatches.map((item) => (
              <button
                key={item.code}
                type="button"
                className={`flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-slate-50 ${
                  item.code === code ? "bg-cyan-50 text-cyan-700" : "text-slate-600"
                }`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setCode(item.code);
                  setMaturityDate(estimateRepoMaturityDateKey(tradeDate, item.termDays));
                  setPickerOpen(false);
                }}
              >
                <span className="flex items-center gap-2">
                  <span className="font-mono tabular-nums">{item.code}</span>
                  <span className="font-medium text-slate-700">{item.name}</span>
                </span>
                <span className="shrink-0 text-[11px] text-slate-400">
                  {item.termDays}
                  {t("repoForm.dayUnit")} · {REPO_MARKET_LABEL[item.market]}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {product ? (
        <div className="text-[11px] text-slate-500">
          {t("repoForm.productResolved", {
            name: product.name,
            days: product.termDays,
            market: REPO_MARKET_LABEL[product.market],
          })}
        </div>
      ) : (
        <div className="flex items-center gap-2 text-[11px] text-amber-600">
          <span>{t("repoForm.codeUnknown")}</span>
          <button
            type="button"
            className="rounded border border-amber-300 px-1.5 py-0.5 text-[11px] text-amber-700 hover:bg-amber-50"
            onClick={() => {
              setNewCode(code.trim());
              setCreateOpen(true);
            }}
          >
            {t("repoForm.addProduct")}
          </button>
        </div>
      )}

      {createOpen ? (
        <div className="mt-2 space-y-2 rounded-lg border border-cyan-200 bg-cyan-50/60 p-3">
          <div className="text-xs font-medium text-slate-600">{t("repoForm.customTitle")}</div>
          <div className="grid grid-cols-2 gap-2">
            <input
              value={newCode}
              onChange={(event) => setNewCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
              className="form-input font-mono tabular-nums"
              inputMode="numeric"
              maxLength={6}
              placeholder={t("repoForm.customCode")}
            />
            <input
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              className="form-input"
              placeholder={t("repoForm.customName")}
            />
            <select
              value={newMarket}
              onChange={(event) => setNewMarket(event.target.value === "sz" ? "sz" : "sh")}
              className="form-input"
            >
              <option value="sh">{REPO_MARKET_LABEL.sh}</option>
              <option value="sz">{REPO_MARKET_LABEL.sz}</option>
            </select>
            <input
              value={newTermDays}
              onChange={(event) => setNewTermDays(event.target.value)}
              className="form-input"
              inputMode="numeric"
              placeholder={t("repoForm.customTerm")}
            />
          </div>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50"
              onClick={() => {
                setCreateOpen(false);
                setNewCode("");
                setNewName("");
                setNewTermDays("");
              }}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              disabled={creating}
              className="rounded-md bg-cyan-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-cyan-700 disabled:opacity-60"
              onClick={async () => {
                if (creating) return;
                setCreating(true);
                try {
                  const res = await fetch("/api/v1/repo/custom-products", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      code: newCode.trim(),
                      name: newName.trim(),
                      market: newMarket,
                      termDays: newTermDays.trim(),
                    }),
                  });
                  const data = (await res.json().catch(() => null)) as
                    | { ok?: boolean; error?: string; product?: CustomRepoProductRow }
                    | null;
                  if (!res.ok || !data?.ok || !data.product) {
                    throw new Error(data?.error ?? t("repoForm.alert.saveFailed"));
                  }
                  const created = data.product;
                  setCustomProducts((prev) => [...prev, created]);
                  setCode(created.code);
                  setMaturityDate(estimateRepoMaturityDateKey(tradeDate, created.termDays));
                  setCreateOpen(false);
                  setNewCode("");
                  setNewName("");
                  setNewTermDays("");
                } catch (error) {
                  window.alert(error instanceof Error ? error.message : t("repoForm.alert.saveFailed"));
                } finally {
                  setCreating(false);
                }
              }}
            >
              {t("common.save")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );

  return (
    <>
      <div className="text-[11px] text-slate-400">{t("repoForm.inlineHint")}</div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <div className="form-label">{t("repoForm.tradeDate")}</div>
          <DateStepper value={tradeDate} onChange={setTradeDate} />
        </div>
        {accountField}
        {codeField}
        <div className="space-y-1">
          <div className="form-label">{t("repoForm.cashAccount")}</div>
          <SmartSelect
            mode="single"
            value={cashAccountId}
            onChange={setCashAccountId}
            options={cashOptions}
            placeholder={t("repoForm.cashAccountPlaceholder")}
            onCreateClick={onCreateCashAccount}
            createLabel={createCashAccountLabel}
            behavior={{ search: true, density: "compact", minDropdownWidth: 260 }}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <div className="form-label">{t("repoForm.amount")}</div>
          <CalcInput value={amount} onChange={setAmount} placeholder={t("txForm.amount")} label={t("repoForm.amount")} precision={2} />
          {product && principal > 0 && principal % product.stepAmount !== 0 ? (
            <div className="text-[11px] text-amber-600">
              {t("repoForm.amountStepHint", { step: formatMoney(product.stepAmount) })}
            </div>
          ) : (
            <div className="text-[11px] text-slate-400">
              {t("repoForm.amountHint", { code: product?.code ?? "", min: formatMoney(product?.minAmount ?? 0) })}
            </div>
          )}
        </div>
        <div className="space-y-1">
          <div className="form-label">{t("repoForm.annualRate")} %</div>
          <CalcInput value={annualRate} onChange={setAnnualRate} placeholder="0.000" label={t("repoForm.annualRate")} precision={3} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <div className="form-label">{t("repoForm.maturityDate")}</div>
          <DateStepper value={maturityDate} onChange={setMaturityDate} />
          <div className="text-[11px] text-slate-400">{t("repoForm.autoRedeemHint")}</div>
        </div>
        <div className="space-y-1">
          <div className="form-label">{t("txForm.fee")}</div>
          <CalcInput value={fee} onChange={setFee} placeholder={formatAmountDraft(feeEstimate)} label={t("txForm.fee")} precision={2} />
        </div>
      </div>

      <div className="space-y-1">
        <div className="form-label">{t("repoForm.note")} <span className="text-slate-400">{t("stockFee.optional")}</span></div>
        <input value={note} onChange={(event) => setNote(event.target.value)} className="form-input" placeholder={t("stockFee.optional")} />
      </div>

      {/* 用户只需要「品种 + 金额 + 年化」，其余按交易所口径自动算给他看。 */}
      <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
        {t("repoForm.preview", {
          days: occupiedDays,
          interest: formatMoney(expectedInterest),
          fee: formatMoney(effectiveFee),
          arrival: formatMoney(arrivalPreview),
        })}
      </div>
    </>
  );
});
