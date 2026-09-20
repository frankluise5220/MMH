"use client";

import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { todayDateLocalYmd as todayDateInputValue } from "@/lib/date-utils";
import { useI18n } from "@/lib/i18n";

function splitDateInputValue(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return { year: match[1]!, month: match[2]!, day: match[3]! };
}

function addDays(value: string, delta: number) {
  const base = splitDateInputValue(value) ? value : todayDateInputValue();
  const [year, month, day] = base.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + delta);
  const nextYear = date.getFullYear();
  const nextMonth = String(date.getMonth() + 1).padStart(2, "0");
  const nextDay = String(date.getDate()).padStart(2, "0");
  return `${nextYear}-${nextMonth}-${nextDay}`;
}

export function DateStepper({ value, onChange, onBlur, onKeyDown, min = "1900-01-01", max = "2999-12-31", className, disabled, name, autoFocus, compact = false }: {
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  min?: string;
  max?: string;
  className?: string;
  disabled?: boolean;
  name?: string;
  autoFocus?: boolean;
  compact?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // 日历打开期间用本地 draft 跟着翻年/翻月走，不把中间值交给父级。
  const [draft, setDraft] = useState<string | null>(null);
  // Chromium `showPicker()` 会在打开瞬间（空值时常填成今天）派 input/change，
  // 关闭未点选时也可能再提交一次。都不是用户点选。
  // 日历打开后翻年/翻月只派 input（React onChange 听的就是它），真正点某一天才派 change。
  const suppressPickerSideEffectRef = useRef(false);
  const suppressPickerTimerRef = useRef<number | null>(null);
  const ignorePickerCommitRef = useRef(false);
  const ignorePickerCommitTimerRef = useRef<number | null>(null);
  const pickerOpenRef = useRef(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const valueRef = useRef(value);
  valueRef.current = value;
  const { t } = useI18n();
  const displayedValue = draft ?? value;

  const stopSuppressingPickerSideEffect = () => {
    suppressPickerSideEffectRef.current = false;
    if (suppressPickerTimerRef.current != null) {
      window.clearTimeout(suppressPickerTimerRef.current);
      suppressPickerTimerRef.current = null;
    }
  };

  const revertInputToParentValue = (input: HTMLInputElement) => {
    const current = valueRef.current;
    input.value = current;
    const tracker = (input as HTMLInputElement & { _valueTracker?: { setValue: (next: string) => void } })._valueTracker;
    tracker?.setValue(current);
  };

  const closePickerWithoutCommit = (input: HTMLInputElement) => {
    pickerOpenRef.current = false;
    setPickerOpen(false);
    setDraft(null);
    stopSuppressingPickerSideEffect();
    revertInputToParentValue(input);
    armIgnorePickerCommit();
  };

  const armIgnorePickerCommit = () => {
    ignorePickerCommitRef.current = true;
    if (ignorePickerCommitTimerRef.current != null) {
      window.clearTimeout(ignorePickerCommitTimerRef.current);
    }
    ignorePickerCommitTimerRef.current = window.setTimeout(() => {
      ignorePickerCommitTimerRef.current = null;
      ignorePickerCommitRef.current = false;
    }, 200);
  };

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const onCancel = () => {
      // 打开瞬间 Chromium 可能立刻 cancel（无头/showPicker 失败）；那不是用户关掉。
      if (suppressPickerSideEffectRef.current) return;
      closePickerWithoutCommit(input);
    };
    const onNativeChange = () => {
      if (suppressPickerSideEffectRef.current || ignorePickerCommitRef.current) {
        revertInputToParentValue(input);
        return;
      }
      // 键盘输入走 React onChange（input）。这里只收日历里真正点某一天的 change。
      if (!pickerOpenRef.current) return;
      const next = input.value;
      pickerOpenRef.current = false;
      setPickerOpen(false);
      setDraft(null);
      onChangeRef.current(next);
    };
    input.addEventListener("cancel", onCancel);
    input.addEventListener("change", onNativeChange);
    return () => {
      input.removeEventListener("cancel", onCancel);
      input.removeEventListener("change", onNativeChange);
    };
  }, []);

  useEffect(() => () => {
    if (suppressPickerTimerRef.current != null) {
      window.clearTimeout(suppressPickerTimerRef.current);
    }
    if (ignorePickerCommitTimerRef.current != null) {
      window.clearTimeout(ignorePickerCommitTimerRef.current);
    }
  }, []);

  const changeByDays = (delta: number) => {
    if (disabled) return;
    const next = addDays(value, delta);
    if (min && next < min) return;
    if (max && next > max) return;
    onChange(next);
  };

  const togglePicker = () => {
    if (disabled) return;
    const input = inputRef.current;
    if (!input) return;
    if (pickerOpen || pickerOpenRef.current) {
      input.blur();
      closePickerWithoutCommit(input);
      return;
    }
    // Chromium：空值 showPicker() 常同步把 value 填成今天并派 input/change；
    // 已有值时打开日历也可能再派一次相同日期。都不是用户点选。
    stopSuppressingPickerSideEffect();
    suppressPickerSideEffectRef.current = true;
    pickerOpenRef.current = true;
    setPickerOpen(true);
    setDraft(null);
    input.showPicker?.();
    if (input.value !== valueRef.current) {
      revertInputToParentValue(input);
    }
    // 覆盖同步 + 下一个宏任务的自动填值。用户点选日历发生在弹层出现之后，远大于 100ms。
    suppressPickerTimerRef.current = window.setTimeout(() => {
      suppressPickerTimerRef.current = null;
      suppressPickerSideEffectRef.current = false;
    }, 100);
  };

  return (
    <div className="relative min-w-0">
      <input
        ref={inputRef}
        name={name}
        type="date"
        value={displayedValue}
        min={min}
        max={max}
        disabled={disabled}
        autoFocus={autoFocus}
        onChange={(event) => {
          if (suppressPickerSideEffectRef.current || ignorePickerCommitRef.current) {
            revertInputToParentValue(event.target);
            return;
          }
          if (pickerOpenRef.current) {
            // 日历内翻年/翻月：只派 input。跟着 draft 走，不向上提交。
            setDraft(event.target.value);
            return;
          }
          onChange(event.target.value);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          // 打开日历常会立刻 blur；此时 overlay 仍在，不能清 pickerOpenRef，否则翻年的 input 会漏出去。
          const shouldRevert = suppressPickerSideEffectRef.current || ignorePickerCommitRef.current;
          stopSuppressingPickerSideEffect();
          if (shouldRevert && inputRef.current) {
            revertInputToParentValue(inputRef.current);
          }
          onBlur?.();
        }}
        className={`form-input date-stepper-input min-w-0 ${compact ? "pr-1" : "pr-12"} disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500 invalid:border-rose-400 invalid:text-rose-700 invalid:focus:border-rose-400 ${className ?? ""}`}
      />
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={togglePicker}
        disabled={disabled}
        className={`absolute bottom-px ${compact ? "right-0.5" : "right-5"} top-px flex ${compact ? "w-6" : "w-7"} items-center justify-center text-slate-500 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40`}
        title={t("dateStepper.pickDate")}
        aria-label={t("dateStepper.pickDate")}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[1.1rem] w-[1.1rem]">
          <path d="M7 3v3M17 3v3M4.5 9h15M6.5 5h11a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
        </svg>
      </button>
      {!compact && (
      <div className="absolute inset-y-0.5 right-0.5 flex w-5 flex-col overflow-hidden rounded-r-[8px] border-l border-slate-200/60 bg-white/80">
        <button
          type="button"
          onClick={() => changeByDays(1)}
          disabled={disabled || Boolean(max && addDays(value, 1) > max)}
          className="flex flex-1 items-center justify-center text-[9px] leading-none text-slate-500 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
          title={t("dateStepper.nextDay")}
          aria-label={t("dateStepper.nextDay")}
        >
          <span className="rotate-90 text-[13px] leading-none">‹</span>
        </button>
        <button
          type="button"
          onClick={() => changeByDays(-1)}
          disabled={disabled || Boolean(min && addDays(value, -1) < min)}
          className="flex flex-1 items-center justify-center border-t border-slate-200 text-[9px] leading-none text-slate-500 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
          title={t("dateStepper.prevDay")}
          aria-label={t("dateStepper.prevDay")}
        >
          <span className="rotate-90 text-[13px] leading-none">›</span>
        </button>
      </div>
      )}
    </div>
  );
}
