"use client";

export function DepositCreateButton({
  defaultCashAccountId,
  defaultDepositAccountId,
  defaultSubtype = "buy",
}: {
  defaultCashAccountId?: string;
  defaultDepositAccountId?: string;
  defaultSubtype?: "buy" | "redeem";
}) {
  return (
    <button
      type="button"
      onClick={() => {
        window.dispatchEvent(
          new CustomEvent("mmh:deposit:create", {
            detail: {
              requestId: `create-${Date.now()}`,
              defaultCashAccountId: defaultCashAccountId ?? "",
              defaultDepositAccountId: defaultDepositAccountId ?? "",
              defaultSubtype,
            },
          }),
        );
      }}
      className="primary-button h-8 px-3 text-xs"
    >
      存款记一笔
    </button>
  );
}
