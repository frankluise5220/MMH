"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Unlock } from "lucide-react";

import { formatMoneyYuan as formatMoney, roundDisplayNumber } from "@/lib/format";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { useI18n } from "@/lib/i18n";

export default function EditBillAmount({
  accountId,
  statementMonth,
  currentAmount,
  hasOverride,
  displayMultiplier = 1,
  postOverrideAdjustment = 0,
}: {
  accountId: string;
  statementMonth: string;
  currentAmount: number;
  hasOverride: boolean;
  displayMultiplier?: 1 | -1;
  postOverrideAdjustment?: number;
}) {
  const [editing, setEditing] = useState(false);
  const [committedAmount, setCommittedAmount] = useState(currentAmount);
  const [localHasOverride, setLocalHasOverride] = useState(hasOverride);
  // 显示口径统一先收成两位小数：单元格文字（formatMoney）与输入框初值必须是同一个数，
  // 否则「点一下进编辑」就会看到尾数变化，失焦时还被当成用户改过数字。
  const displayAmount = roundDisplayNumber(committedAmount * displayMultiplier, 2);
  const [val, setVal] = useState(String(displayAmount.toFixed(2)));
  const [saving, setSaving] = useState(false);
  const [errMsg, setErrMsg] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const savingRef = useRef(false);
  const skipBlurCommitRef = useRef(false);
  // 进编辑那一刻看到的数字：失焦时只要和它一样就当作没改，绝不写 override。
  const editStartDisplayRef = useRef(displayAmount);
  const { t } = useI18n();

  useEffect(() => {
    setCommittedAmount(currentAmount);
  }, [currentAmount]);

  useEffect(() => {
    setLocalHasOverride(hasOverride);
  }, [hasOverride]);

  useEffect(() => {
    if (!editing) {
      setVal(displayAmount.toFixed(2));
      setErrMsg("");
    }
  }, [displayAmount, editing]);

  useEffect(() => {
    if (!editing) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    const caret = input.value.length;
    input.setSelectionRange(caret, caret);
  }, [editing]);

  useEffect(() => {
    function handleBillOverrideChanged(event: Event) {
      const detail = (event as CustomEvent<{
        accountId?: string;
        statementMonth?: string;
        amount?: number | null;
        hasOverride?: boolean;
      }>).detail;
      if (!detail?.accountId || !detail?.statementMonth) return;
      if (detail.accountId !== accountId || detail.statementMonth !== statementMonth) return;
      if (typeof detail.amount === "number") setCommittedAmount(detail.amount);
      if (typeof detail.hasOverride === "boolean") setLocalHasOverride(detail.hasOverride);
    }

    window.addEventListener("mmh:bill-override:changed", handleBillOverrideChanged as EventListener);
    return () => window.removeEventListener("mmh:bill-override:changed", handleBillOverrideChanged as EventListener);
  }, [accountId, statementMonth]);

  const startEdit = useCallback(() => {
    if (savingRef.current) return;
    skipBlurCommitRef.current = false;
    editStartDisplayRef.current = displayAmount;
    setVal(displayAmount.toFixed(2));
    setErrMsg("");
    setEditing(true);
  }, [displayAmount]);

  const cancelEdit = useCallback(() => {
    skipBlurCommitRef.current = true;
    setVal(displayAmount.toFixed(2));
    setErrMsg("");
    setEditing(false);
  }, [displayAmount]);

  /**
   * 解析输入框里的数字，返回「绝对值 + 用户显式写的符号」。
   *
   * 符号不能在这里替用户猜：账单金额显示为负数（流出），但溢缴/多还的账单显示为正数。
   * 早先「没写符号一律当流出（-abs）」的规则会把正数显示的那几期在失焦时翻成欠款，
   * 用户什么都没改却生成了 override（账单被锁）。现在只有显式写 + / - 才改符号，
   * 否则沿用这一格原来的符号。
   */
  const parseDisplayInput = useCallback((raw: string) => {
    const trimmed = raw.trim().replace(/[,，\s¥￥]/g, "");
    if (!trimmed) return null;
    const explicitPositive = trimmed.startsWith("+");
    const explicitNegative = trimmed.startsWith("-");
    const numericPart = trimmed.replace(/^[+-]/, "");
    if (!numericPart) return null;
    const parsed = Number(numericPart);
    if (!Number.isFinite(parsed)) return null;
    return {
      abs: Math.abs(parsed),
      // 0 = 没写符号
      sign: explicitPositive ? 1 : explicitNegative ? -1 : 0,
    };
  }, []);

  const focusInput = useCallback(() => {
    requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true });
      const caret = inputRef.current?.value.length ?? 0;
      inputRef.current?.setSelectionRange(caret, caret);
    });
  }, []);

  const save = useCallback(async (amount: number) => {
    if (!accountId || !statementMonth) return;
    setSaving(true);
    setErrMsg("");
    try {
      const res = await fetch("/api/v1/bill/override", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, statementMonth, amount: amount + postOverrideAdjustment }),
      });
      const data = await res.json();
      if (data.ok) {
        setCommittedAmount(amount);
        setLocalHasOverride(true);
        window.dispatchEvent(
          new CustomEvent("mmh:bill-override:changed", {
            detail: {
              accountId,
              statementMonth,
              amount,
              hasOverride: true,
            },
          }),
        );
        dispatchFinanceDataChanged({ reason: "bill-override", accountIds: [accountId], statementMonth, balanceChanged: true });
        setEditing(false);
        setSaving(false);
        return;
      }
      setErrMsg(data.error || t("editBill.saveFailed"));
    } catch {
      setErrMsg(t("editBill.networkError"));
    }
    skipBlurCommitRef.current = false;
    setSaving(false);
    focusInput();
  }, [accountId, focusInput, postOverrideAdjustment, statementMonth, t]);

  const commit = useCallback(async () => {
    if (savingRef.current) return;
    const parsed = parseDisplayInput(val);
    if (!parsed) {
      setErrMsg(t("editBill.invalidAmount"));
      focusInput();
      return;
    }
    const startDisplay = editStartDisplayRef.current;
    // 没写符号时沿用进编辑时这一格的正负：正常账单是负（流出），溢缴/多还是正。
    const sign = parsed.sign !== 0 ? parsed.sign : startDisplay > 0 ? 1 : -1;
    const nextDisplay = roundDisplayNumber(sign * parsed.abs, 2);
    // 数字没变（含只点了一下、或只是把显示值原样敲回来）就什么都不做：
    // 不写 override、不锁账单、也不把后台刷新改过的值当成用户输入。
    if (Math.abs(nextDisplay - displayAmount) < 0.005 || Math.abs(nextDisplay - startDisplay) < 0.005) {
      setVal(displayAmount.toFixed(2));
      setErrMsg("");
      setEditing(false);
      return;
    }
    const amount = roundDisplayNumber(nextDisplay / displayMultiplier, 2);
    savingRef.current = true;
    skipBlurCommitRef.current = true;
    try {
      await save(amount);
    } finally {
      savingRef.current = false;
    }
  }, [displayAmount, displayMultiplier, focusInput, parseDisplayInput, save, t, val]);

  const handleBlur = useCallback(() => {
    if (skipBlurCommitRef.current) {
      skipBlurCommitRef.current = false;
      return;
    }
    void commit();
  }, [commit]);

  const reset = useCallback(async () => {
    if (!accountId || !statementMonth) return;
    setSaving(true);
    try {
      await fetch(`/api/v1/bill/override?accountId=${accountId}&statementMonth=${statementMonth}`, { method: "DELETE" });
      await new Promise((resolve) => setTimeout(resolve, 60));
      dispatchFinanceDataChanged({ reason: "bill-override-reset", accountIds: [accountId], statementMonth, balanceChanged: true });
    } catch {
      // ignore
    }
    setSaving(false);
  }, [accountId, statementMonth]);

  const amountText = formatMoney(displayAmount);

  return (
    <span
      className={[
        "relative -mx-3 flex w-full items-center justify-end gap-1 px-3 tabular-nums transition-colors",
        editing ? "bg-blue-100" : "cursor-pointer hover:bg-slate-50",
      ].join(" ")}
      data-edit-bill-active={editing ? "true" : undefined}
      // 就地编辑时焦点落在输入框上，这张表不该把它当成「键盘活动行」画整行蓝框
      data-advanced-table-skip-row-highlight="true"
      // 整格拦截点击，不让 AdvancedDataTable 的 onRowClick 选中/切换账单行
      onClick={(event) => {
        event.stopPropagation();
        if (!editing) startEdit();
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      title={editing ? undefined : t("editBill.clickToEdit")}
    >
      {/* 输入框绝对定位覆盖文字；不画自己的边框，编辑态只用这一格的背景色区分 */}
      <span className="relative inline-flex min-w-[4.5rem] items-center justify-end">
        <span className={editing ? "text-transparent" : "hover:text-blue-600"} data-edit-bill-amount={statementMonth}>
          {amountText}
        </span>
        {editing ? (
          <input
            ref={inputRef}
            type="text"
            inputMode="decimal"
            aria-label={t("editBill.clickToEdit")}
            title={errMsg || t("editBill.editHint")}
            className={[
              "absolute inset-0 w-full bg-transparent text-right tabular-nums caret-blue-700 outline-none",
              errMsg ? "text-red-600" : "",
            ].join(" ")}
            value={val}
            onChange={(event) => {
              setVal(event.target.value);
              if (errMsg) setErrMsg("");
            }}
            onBlur={handleBlur}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void commit();
              } else if (event.key === "Escape") {
                event.preventDefault();
                cancelEdit();
              }
            }}
            disabled={saving}
          />
        ) : null}
        {errMsg ? (
          <span className="pointer-events-none absolute left-full top-1/2 z-20 ml-2 -translate-y-1/2 whitespace-nowrap text-[10px] text-red-600">
            {errMsg}
          </span>
        ) : null}
      </span>
      {localHasOverride ? (
        <Unlock
          className={`h-3.5 w-3.5 shrink-0 ${editing ? "invisible" : "cursor-pointer text-orange-400 hover:text-orange-600"}`}
          onClick={(event) => {
            if (editing) return;
            event.stopPropagation();
            void reset();
          }}
          aria-label={t("editBill.unlockReset")}
        />
      ) : null}
    </span>
  );
}
