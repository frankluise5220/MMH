"use client";

import { ChevronDown, Plus } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

type EntryKind =
  | "transaction"
  | "advance"
  | "transfer"
  | "investment"
  | "metal"
  | "wealth"
  | "deposit"
  | "deposit-buy"
  | "deposit-redeem"
  | "insurance"
  | "debt"
  | "regular-task";

type EntryAction = {
  key: EntryKind;
  label: string;
  disabled?: boolean;
};

type Props = {
  defaultAction: EntryKind;
  actions: EntryAction[];
  className?: string;
  context?: {
    defaultAccountId?: string;
    defaultCashAccountId?: string;
    defaultTransferFromAccountId?: string;
    defaultTransferToAccountId?: string;
    defaultInvestmentAccountId?: string;
    defaultMetalAccountId?: string;
    defaultWealthAccountId?: string;
    defaultDepositAccountId?: string;
    defaultDepositSubtype?: "buy" | "redeem";
    defaultInsuranceAccountId?: string;
    defaultDebtAccountId?: string;
    defaultDebtInstitutionId?: string;
    defaultScheduledTaskType?: "fund_regular_invest" | "loan_repayment" | "transfer" | "insurance_premium";
  };
};

function makeRequestId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function dispatchEntryAction(kind: EntryKind, context?: Props["context"]) {
  if (typeof window === "undefined") return;
  const requestId = makeRequestId(kind);
  switch (kind) {
    case "transaction":
      window.dispatchEvent(
        new CustomEvent("mmh:create-transaction:open", {
          detail: {
            requestId,
            source: "launcher",
            item: { type: "expense" },
            defaultAccountId: context?.defaultAccountId ?? "",
          },
        }),
      );
      return;
    case "advance":
      window.dispatchEvent(
        new CustomEvent("mmh:create-transaction:open", {
          detail: {
            requestId,
            source: "launcher",
            item: { type: "advance" },
            defaultAccountId: context?.defaultAccountId ?? "",
          },
        }),
      );
      return;
    case "transfer":
      window.dispatchEvent(
        new CustomEvent("mmh:create-transaction:open", {
          detail: {
            requestId,
            source: "launcher",
            item: { type: "transfer" },
            defaultAccountId: context?.defaultTransferFromAccountId ?? context?.defaultAccountId ?? "",
            defaultFromAccountId: context?.defaultTransferFromAccountId ?? context?.defaultAccountId ?? "",
            defaultToAccountId: context?.defaultTransferToAccountId ?? "",
          },
        }),
      );
      return;
    case "investment":
      window.dispatchEvent(
        new CustomEvent("mmh:investment:create", {
          detail: {
            requestId,
            defaultAccountId: context?.defaultInvestmentAccountId ?? "",
            defaultCashAccountId: context?.defaultCashAccountId ?? context?.defaultAccountId ?? "",
            defaultProductType: "fund",
          },
        }),
      );
      return;
    case "metal":
      window.dispatchEvent(
        new CustomEvent("mmh:investment:create", {
          detail: {
            requestId,
            defaultAccountId: context?.defaultMetalAccountId ?? "",
            defaultCashAccountId: context?.defaultCashAccountId ?? context?.defaultAccountId ?? "",
            defaultProductType: "metal",
          },
        }),
      );
      return;
    case "wealth":
      window.dispatchEvent(
        new CustomEvent("mmh:wealth:create", {
          detail: {
            requestId,
            defaultCashAccountId: context?.defaultCashAccountId ?? context?.defaultAccountId ?? "",
            defaultWealthAccountId: context?.defaultWealthAccountId ?? "",
          },
        }),
      );
      return;
    case "deposit":
      window.dispatchEvent(
        new CustomEvent("mmh:deposit:create", {
          detail: {
            requestId,
            defaultSubtype: context?.defaultDepositSubtype ?? "buy",
            defaultCashAccountId: context?.defaultCashAccountId ?? context?.defaultAccountId ?? "",
            defaultDepositAccountId: context?.defaultDepositAccountId ?? context?.defaultAccountId ?? "",
          },
        }),
      );
      return;
    case "deposit-buy":
      window.dispatchEvent(
        new CustomEvent("mmh:deposit:create", {
          detail: {
            requestId,
            defaultSubtype: "buy",
            defaultCashAccountId: context?.defaultCashAccountId ?? context?.defaultAccountId ?? "",
            defaultDepositAccountId: context?.defaultDepositAccountId ?? context?.defaultAccountId ?? "",
          },
        }),
      );
      return;
    case "deposit-redeem":
      window.dispatchEvent(
        new CustomEvent("mmh:deposit:create", {
          detail: {
            requestId,
            defaultSubtype: "redeem",
            defaultCashAccountId: context?.defaultCashAccountId ?? context?.defaultAccountId ?? "",
            defaultDepositAccountId: context?.defaultDepositAccountId ?? context?.defaultAccountId ?? "",
          },
        }),
      );
      return;
    case "insurance":
      window.dispatchEvent(
        new CustomEvent("mmh:insurance:create", {
          detail: {
            requestId,
            defaultCashAccountId: context?.defaultCashAccountId ?? context?.defaultAccountId ?? "",
            defaultInsuranceAccountId: context?.defaultInsuranceAccountId ?? context?.defaultAccountId ?? "",
          },
        }),
      );
      return;
    case "debt":
      window.dispatchEvent(
        new CustomEvent("mmh:debt:create", {
          detail: {
            requestId,
            defaultDebtAccountId: context?.defaultDebtAccountId ?? "",
            defaultDebtInstitutionId: context?.defaultDebtInstitutionId ?? "",
            defaultCashAccountId: context?.defaultCashAccountId ?? context?.defaultAccountId ?? "",
          },
        }),
      );
      return;
    case "regular-task":
      window.dispatchEvent(
        new CustomEvent("mmh:regular-task:create", {
          detail: {
            requestId,
            taskType: context?.defaultScheduledTaskType ?? "fund_regular_invest",
            defaultCashAccountId: context?.defaultCashAccountId ?? context?.defaultAccountId ?? "",
            defaultAccountId: context?.defaultAccountId ?? "",
          },
        }),
      );
      return;
  }
}

export function UnifiedEntryLauncher({ defaultAction, actions, className, context }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const defaultItem = useMemo(
    () => actions.find((item) => item.key === defaultAction && !item.disabled) ?? actions.find((item) => !item.disabled),
    [actions, defaultAction],
  );

  useEffect(() => {
    if (!menuOpen) return;
    const updatePosition = () => {
      const wrap = wrapRef.current;
      const menu = menuRef.current;
      if (!wrap) return;
      const rect = wrap.getBoundingClientRect();
      const menuWidth = menu?.offsetWidth ?? 224;
      const menuHeight = menu?.offsetHeight ?? 336;
      const viewportPadding = 8;
      const rightEdge = window.innerWidth - viewportPadding;
      const leftEdge = viewportPadding;
      const topEdge = viewportPadding;
      const bottomEdge = window.innerHeight - viewportPadding;
      const left = Math.max(leftEdge, Math.min(rect.right - menuWidth, rightEdge - menuWidth));
      const spaceBelow = bottomEdge - rect.bottom;
      const spaceAbove = rect.top - topEdge;
      const top =
        spaceBelow >= menuHeight || spaceBelow >= spaceAbove
          ? Math.max(topEdge, Math.min(rect.bottom + 6, bottomEdge - menuHeight))
          : Math.max(topEdge, rect.top - menuHeight - 6);
      setMenuStyle({
        position: "fixed",
        top,
        left,
        zIndex: 9999,
      });
    };
    const raf = window.requestAnimationFrame(updatePosition);
    function onPointerDown(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (wrapRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setMenuOpen(false);
    }
    function onEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    function onReposition() {
      updatePosition();
    }
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onEscape);
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onEscape);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [menuOpen]);

  return (
    <div ref={wrapRef} className={className ?? "relative inline-flex"}>
      <div className="inline-flex h-8 items-stretch overflow-hidden rounded-full bg-blue-600 text-white shadow-sm ring-1 ring-blue-600/90">
        <button
          type="button"
          onClick={() => {
            setMenuOpen(false);
            if (defaultItem) dispatchEntryAction(defaultItem.key, context);
          }}
          disabled={!defaultItem}
          className="inline-flex items-center gap-1.5 bg-transparent px-3 text-sm font-medium hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus className="h-4 w-4" />
          {defaultItem?.label ?? "记账"}
        </button>
        <div className="my-1 w-px shrink-0 bg-white/35" aria-hidden="true" />
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
          className="inline-flex items-center justify-center bg-transparent px-2.5 hover:bg-white/10"
          title="更多记账入口"
        >
          <ChevronDown className="h-4 w-4 opacity-90" />
        </button>
      </div>
      {menuOpen && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={menuRef}
              className="viewport-menu min-w-[180px] rounded-[12px] border border-slate-200 bg-white py-1 shadow-[0_12px_32px_rgba(15,23,42,0.16)]"
              data-menu-open="true"
              style={menuStyle ?? { position: "fixed", top: 0, left: 0, zIndex: 9999 }}
            >
              {actions.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  disabled={item.disabled}
                  onClick={() => {
                    setMenuOpen(false);
                    if (!item.disabled) dispatchEntryAction(item.key, context);
                  }}
                  className="flex w-full items-center px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300 disabled:hover:bg-white"
                >
                  {item.label}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
