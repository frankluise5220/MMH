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
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { formatAmountDraft, formatMoney } from "@/lib/format";
import { todayDateLocalYmd } from "@/lib/date-utils";
import { useI18n } from "@/lib/i18n";
import {
  estimateRepoFee,
  estimateRepoInterest,
  estimateRepoMaturityDateKey,
  REPO_MARKET_LABEL,
  REPO_PRODUCTS,
  repoOccupiedDays,
  repoProductByCode,
} from "@/lib/repo";

/**
 * 逆回购录入字段（借出 / 到期回款）。
 *
 * 逆回购是债券账户下的一种动作，与买入/赎回/收息/核销共用「新增债券记录」窗口：
 * 窗口只负责页签与页脚，字段与提交都在这里，避免再开一个独立小窗。
 */

export type RepoEntryMode = "lend" | "redeem";

export type RepoCashAccountOption = {
  id: string;
  label: string;
  title?: string | null;
  kind?: string | null;
  institutionId?: string | null;
};

export type RepoOpenLotOption = {
  id: string;
  name: string;
  startDate: string | null;
  maturityDate: string | null;
  principal: number;
  annualRate: number | null;
  termDays: number | null;
  expectedInterest: number | null;
  remainingDays: number | null;
};

export type RepoEntryFieldsHandle = {
  /** 由外层窗口的页脚「保存」按钮调用（回车提交同样走这里）。 */
  submit: () => Promise<void>;
};

type Props = {
  /** 逆回购归属的债券账户（券商账户）。 */
  accountId: string;
  accountLabel: string;
  /** 债券账户下拉（不传则只读显示 accountLabel）。 */
  accountOptions?: SmartSelectOption[];
  onAccountChange?: (accountId: string) => void;
  /** 券商机构，用于默认挑出该券商的资金账户。 */
  institutionId?: string | null;
  cashAccounts: RepoCashAccountOption[];
  defaultCashAccountId?: string | null;
  /** 未回款的逆回购存单（回款模式的下拉）。 */
  lots: RepoOpenLotOption[];
  lotsLoading?: boolean;
  /** 由外层 FT 页签决定：逆回购借出 / 逆回购回款各是一个页签。 */
  mode: RepoEntryMode;
  initialLotId?: string | null;
  /** 窗口每次重新打开 / 切到逆回购页签时递增，用来丢掉上一次的草稿。 */
  resetKey: number;
  onSubmittingChange?: (submitting: boolean) => void;
  onSaved?: () => void;
};

const LAST_DRAFT_KEY = "mmh:repo:last-draft:v1";

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
    lots,
    lotsLoading = false,
    mode,
    initialLotId,
    resetKey,
    onSubmittingChange,
    onSaved,
  },
  ref,
) {
  const { t } = useI18n();
  const [submitting, setSubmitting] = useState(false);

  // 借出
  const [code, setCode] = useState("204001");
  const [amount, setAmount] = useState("");
  const [annualRate, setAnnualRate] = useState("");
  const [tradeDate, setTradeDate] = useState(todayDateLocalYmd());
  const [maturityDate, setMaturityDate] = useState("");
  const [fee, setFee] = useState("");
  const [cashAccountId, setCashAccountId] = useState("");
  const [note, setNote] = useState("");

  // 回款
  const [lotId, setLotId] = useState("");
  const [arrivalDate, setArrivalDate] = useState(todayDateLocalYmd());
  const [arrivalAmount, setArrivalAmount] = useState("");
  const [redeemInterest, setRedeemInterest] = useState("");

  const product = repoProductByCode(code);
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

  const productOptions = useMemo<SmartSelectOption[]>(() => {
    const groups = new Map<string, SmartSelectOption>();
    for (const item of REPO_PRODUCTS) {
      const key = `market-${item.market}`;
      if (!groups.has(key)) {
        groups.set(key, { id: key, label: REPO_MARKET_LABEL[item.market], isGroup: true });
      }
    }
    const rows: SmartSelectOption[] = [];
    for (const [marketKey, header] of groups.entries()) {
      rows.push(header);
      for (const item of REPO_PRODUCTS.filter((entry) => `market-${entry.market}` === marketKey)) {
        rows.push({
          id: item.code,
          label: `${item.name} · ${item.termDays}${t("repoForm.dayUnit")}`,
          subLabel: item.code,
          parentId: marketKey,
        });
      }
    }
    return rows;
  }, [t]);

  const lotOptions = useMemo<SmartSelectOption[]>(
    () =>
      lots.map((lot) => ({
        id: lot.id,
        label: `${lot.name} · ${formatMoney(lot.principal)}`,
        subLabel: [lot.startDate, lot.maturityDate].filter(Boolean).join(" → "),
      })),
    [lots],
  );

  const pickDefaultCashAccount = useCallback(() => {
    const institution = String(institutionId ?? "").trim();
    const matched = institution
      ? cashAccounts.find((item) => item.kind === "ewallet" && item.institutionId === institution)
      : undefined;
    return (
      matched?.id
      ?? cashAccounts.find((item) => item.id === defaultCashAccountId)?.id
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
    const nextCode = draft?.code && repoProductByCode(draft.code) ? draft.code : "204001";
    setCode(nextCode);
    setAmount(draft?.amount ?? "");
    setAnnualRate(draft?.annualRate ?? "");
    setTradeDate(todayDateLocalYmd());
    setMaturityDate(estimateRepoMaturityDateKey(todayDateLocalYmd(), repoProductByCode(nextCode)?.termDays ?? 1));
    setFee("");
    setNote("");
    setCashAccountId(
      draft?.cashAccountId && cashAccounts.some((item) => item.id === draft.cashAccountId)
        ? draft.cashAccountId
        : pickDefaultCashAccount(),
    );
    setLotId(initialLotId ?? lots[0]?.id ?? "");
    setArrivalDate(todayDateLocalYmd());
    setArrivalAmount("");
    setRedeemInterest("");
  }, [resetKey, mode, initialLotId, lots, cashAccounts, pickDefaultCashAccount]);

  // 成交日或品种变化 → 到期日跟着重算（此后用户仍可手动改，改动日期不会再被覆盖）。
  useEffect(() => {
    setMaturityDate(estimateRepoMaturityDateKey(tradeDate, termDays));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tradeDate, code]);

  // 资金账户 / 存单是异步取来的：落地后补一次默认值，不覆盖用户已选。
  useEffect(() => {
    if (cashAccountId && cashAccounts.some((item) => item.id === cashAccountId)) return;
    const next = pickDefaultCashAccount();
    if (next && next !== cashAccountId) setCashAccountId(next);
  }, [cashAccountId, cashAccounts, pickDefaultCashAccount]);

  useEffect(() => {
    if (mode !== "redeem") return;
    if (lotId && lots.some((lot) => lot.id === lotId)) return;
    const preferred = initialLotId && lots.some((lot) => lot.id === initialLotId) ? initialLotId : null;
    const next = preferred ?? lots[0]?.id ?? "";
    if (next !== lotId) setLotId(next);
  }, [mode, lots, lotId, initialLotId]);

  const occupiedDays = repoOccupiedDays(tradeDate, maturityDate);
  const principal = num(amount);
  const expectedInterest = estimateRepoInterest({
    principal,
    annualRate: num(annualRate) || null,
    occupiedDays,
  });
  const feeEstimate = estimateRepoFee(principal, termDays);
  const effectiveFee = fee === "" ? feeEstimate : num(fee);
  const arrivalPreview = Number((principal + expectedInterest - effectiveFee).toFixed(2));

  const selectedLot = useMemo(() => lots.find((lot) => lot.id === lotId) ?? null, [lotId, lots]);
  const redeemOccupiedDays = repoOccupiedDays(selectedLot?.startDate ?? "", arrivalDate);
  const redeemInterestEstimate = selectedLot
    ? estimateRepoInterest({ principal: selectedLot.principal, annualRate: selectedLot.annualRate, occupiedDays: redeemOccupiedDays })
    : 0;
  const effectiveRedeemInterest = redeemInterest === "" ? redeemInterestEstimate : num(redeemInterest);
  const effectiveArrivalAmount =
    arrivalAmount === ""
      ? Number(((selectedLot?.principal ?? 0) + effectiveRedeemInterest).toFixed(2))
      : num(arrivalAmount);

  const submit = useCallback(async () => {
    if (submitting) return;
    if (mode === "lend") {
      if (!accountId) return window.alert(t("repoForm.alert.accountRequired"));
      if (!cashAccountId) return window.alert(t("repoForm.alert.cashRequired"));
      if (!product) return window.alert(t("repoForm.alert.productRequired"));
      if (!(principal > 0)) return window.alert(t("repoForm.alert.amountRequired"));
      if (!maturityDate || repoOccupiedDays(tradeDate, maturityDate) <= 0) {
        return window.alert(t("repoForm.alert.maturityInvalid"));
      }
    } else {
      if (!selectedLot) return window.alert(t("repoForm.alert.lotRequired"));
      if (!cashAccountId) return window.alert(t("repoForm.alert.cashRequired"));
      if (!arrivalDate) return window.alert(t("repoForm.alert.arrivalRequired"));
    }

    setSubmitting(true);
    onSubmittingChange?.(true);
    try {
      const url = mode === "lend" ? "/api/v1/repo/lend" : "/api/v1/repo/redeem";
      const body =
        mode === "lend"
          ? {
              accountId,
              cashAccountId,
              date: tradeDate,
              code,
              amount: principal,
              annualRate: num(annualRate) || null,
              termDays,
              maturityDate,
              fee: fee === "" ? null : num(fee),
              note: note.trim() || undefined,
            }
          : {
              lotId,
              arrivalDate,
              cashAccountId,
              arrivalAmount: effectiveArrivalAmount,
              interest: effectiveRedeemInterest,
              note: note.trim() || undefined,
            };
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; cashEntryId?: string } | null;
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? t("repoForm.alert.saveFailed"));

      if (mode === "lend") {
        writeLastDraft({ code, amount, annualRate, cashAccountId });
      }
      dispatchFinanceDataChanged({
        reason: mode === "lend" ? "repo-lend" : "repo-redeem",
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
    // 依赖项按「提交时用到的值」列全，避免闭包拿到旧草稿。
  }, [
    accountId, arrivalAmount, arrivalDate, annualRate, cashAccountId, code,
    effectiveArrivalAmount, effectiveRedeemInterest, fee, lotId, maturityDate, note,
    onSaved, onSubmittingChange, principal, product, selectedLot, submitting, t,
    mode, termDays, tradeDate,
  ]);

  // 外层窗口页脚 / 回车提交都走这个句柄。
  useImperativeHandle(ref, () => ({ submit }), [submit]);

  return (
    <>
      <div className="text-[11px] text-slate-400">{t("repoForm.inlineHint")}</div>

      <div className="space-y-1">
        <div className="form-label">{t("repoForm.account")}</div>
        {accountOptions && onAccountChange ? (
          <SmartSelect
            mode="single"
            value={accountId}
            onChange={onAccountChange}
            options={accountOptions}
            placeholder={t("bondForm.selectAccount")}
            behavior={{ search: true, minDropdownWidth: 260 }}
          />
        ) : (
          <div className="form-input flex items-center text-slate-600" title={accountLabel}>{accountLabel || "-"}</div>
        )}
      </div>

      {mode === "lend" ? (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <div className="form-label">{t("repoForm.product")}</div>
              <SmartSelect
                mode="single"
                value={code}
                onChange={(value) => {
                  setCode(value);
                  const next = repoProductByCode(value);
                  if (next) setMaturityDate(estimateRepoMaturityDateKey(tradeDate, next.termDays));
                }}
                options={productOptions}
                placeholder={t("repoForm.productPlaceholder")}
                behavior={{ search: true, minDropdownWidth: 260 }}
              />
            </div>
            <div className="space-y-1">
              <div className="form-label">{t("repoForm.cashAccount")}</div>
              <SmartSelect
                mode="single"
                value={cashAccountId}
                onChange={setCashAccountId}
                options={cashOptions}
                placeholder={t("repoForm.cashAccountPlaceholder")}
                behavior={{ search: true, minDropdownWidth: 260 }}
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
              <div className="form-label">{t("repoForm.tradeDate")}</div>
              <DateStepper value={tradeDate} onChange={setTradeDate} />
            </div>
            <div className="space-y-1">
              <div className="form-label">{t("repoForm.maturityDate")}</div>
              <DateStepper value={maturityDate} onChange={setMaturityDate} />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <div className="form-label">{t("txForm.fee")}</div>
              <CalcInput value={fee} onChange={setFee} placeholder={formatAmountDraft(feeEstimate)} label={t("txForm.fee")} precision={2} />
            </div>
            <div className="space-y-1">
              <div className="form-label">{t("repoForm.note")} <span className="text-slate-400">{t("stockFee.optional")}</span></div>
              <input value={note} onChange={(event) => setNote(event.target.value)} className="form-input" placeholder={t("stockFee.optional")} />
            </div>
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
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <div className="form-label">{t("repoForm.lot")}</div>
              <SmartSelect
                mode="single"
                value={lotId}
                onChange={setLotId}
                options={lotOptions}
                placeholder={lotsLoading ? t("common.loading") : t("repoForm.lotPlaceholder")}
                behavior={{ search: true, minDropdownWidth: 280 }}
              />
            </div>
            <div className="space-y-1">
              <div className="form-label">{t("repoForm.cashAccount")}</div>
              <SmartSelect
                mode="single"
                value={cashAccountId}
                onChange={setCashAccountId}
                options={cashOptions}
                placeholder={t("repoForm.cashAccountPlaceholder")}
                behavior={{ search: true, minDropdownWidth: 260 }}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <div className="form-label">{t("repoForm.arrivalDate")}</div>
              <DateStepper value={arrivalDate} onChange={setArrivalDate} />
            </div>
            <div className="space-y-1">
              <div className="form-label">{t("repoForm.interest")}</div>
              <CalcInput value={redeemInterest} onChange={setRedeemInterest} placeholder={formatAmountDraft(redeemInterestEstimate)} label={t("repoForm.interest")} precision={2} />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <div className="form-label">{t("repoForm.arrivalAmount")}</div>
              <CalcInput value={arrivalAmount} onChange={setArrivalAmount} placeholder={formatAmountDraft((selectedLot?.principal ?? 0) + redeemInterestEstimate)} label={t("repoForm.arrivalAmount")} precision={2} />
            </div>
            <div className="space-y-1">
              <div className="form-label">{t("repoForm.note")} <span className="text-slate-400">{t("stockFee.optional")}</span></div>
              <input value={note} onChange={(event) => setNote(event.target.value)} className="form-input" placeholder={t("stockFee.optional")} />
            </div>
          </div>

          <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            {t("repoForm.redeemPreview", {
              principal: formatMoney(selectedLot?.principal ?? 0),
              days: redeemOccupiedDays,
              interest: formatMoney(effectiveRedeemInterest),
              arrival: formatMoney(effectiveArrivalAmount),
            })}
          </div>
        </>
      )}
    </>
  );
});
