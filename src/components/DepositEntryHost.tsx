"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { DepositFormModal } from "@/components/DepositFormModal";
import type { SmartSelectOption } from "@/components/SmartSelect";
import { buildAccountDisplayOption } from "@/lib/account-display";
import { getAccountLabelFieldsPreference } from "@/lib/client/appPreferences";
import { fetchSettingsAccountData } from "@/lib/client/settingsCache";

/**
 * 顶部「胶囊记账入口」的存款落地宿主。
 *
 * 入口（TopEntryLauncher / UnifiedEntryLauncher）只负责派发 `mmh:deposit:create`
 * 事件，事件必须由页面挂载的 DepositFormModal 消费。记账页 / 基金视图自带这个
 * 弹窗，账户页、保险页等只放了入口没放弹窗，于是「存款存入 / 存款取出」点了没反应。
 * 这里按需（第一次点入口时）拉一次设置里的账户数据并挂载弹窗，避免给这些页面
 * 增加首屏负担。
 */

/** 必须与 DepositFormModal 里的 AccountOption 结构一致（同名字段、同可选性）。 */
type AccountOption = {
  id: string;
  name?: string;
  kind?: string;
  currency?: string | null;
  institutionId?: string | null;
  label: string;
  icon?: string;
  subLabel?: string;
  investProductType?: string | null;
};

type SettingsAccountRecord = {
  id: string;
  name: string;
  kind?: string | null;
  isActive?: boolean | null;
  isPlaceholder?: boolean | null;
  groupId?: string | null;
  institutionId?: string | null;
  counterpartyId?: string | null;
  numberMasked?: string | null;
  investProductType?: string | null;
  debtDirection?: string | null;
  currency?: string | null;
  billingDay?: number | null;
  Institution?: { name: string | null; shortName?: string | null; type?: string | null } | null;
  AccountGroup?: { id: string; name: string | null } | null;
};

function toOption(account: SettingsAccountRecord): AccountOption {
  const display = buildAccountDisplayOption(
    account as Parameters<typeof buildAccountDisplayOption>[0],
    undefined,
    { fields: getAccountLabelFieldsPreference() },
  );
  return {
    id: account.id,
    name: account.name,
    label: display.selectorLabel || display.label,
    subLabel: display.subLabel,
    kind: account.kind ?? undefined,
    investProductType: account.investProductType ?? null,
    institutionId: account.institutionId ?? null,
    currency: account.currency ?? null,
  };
}

export function DepositEntryHost({
  createAction,
  editAction,
}: {
  createAction: (formData: FormData) => Promise<{ ok: true } | { ok: false; error: string }>;
  editAction?: (formData: FormData) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const [mounted, setMounted] = useState(false);
  const [accounts, setAccounts] = useState<SettingsAccountRecord[]>([]);
  const [openSignal, setOpenSignal] = useState(0);
  const pendingDetailRef = useRef<Record<string, unknown> | null>(null);
  // 补发期间要忽略自己派发出去的事件，否则会「补发 → 再次入队 → 再补发」无限循环。
  const replayingRef = useRef(false);
  const [nestedFieldData, setNestedFieldData] = useState<
    Record<string, Array<{ id: string; name: string; type?: string }>> | undefined
  >(undefined);

  // 只有用户真的点了存款入口才挂载，页面首屏不为这些账户数据买单。
  // 弹窗内部的 onCreate 监听是在挂载后才注册的，而事件此刻已经派发过了 ——
  // 所以这里先把它记下来，等弹窗挂载后（下一帧）再补发同样的请求。
  useEffect(() => {
    function onRequest(ev: Event) {
      if (replayingRef.current) return; // 这是我们自己补发的，交给弹窗消费
      const detail = (ev as CustomEvent<Record<string, unknown>>).detail ?? {};
      if (pendingDetailRef.current) return; // 已有一笔在等，别覆盖
      pendingDetailRef.current = detail;
      setMounted(true);
      setOpenSignal((n) => n + 1);
    }
    window.addEventListener("mmh:deposit:create", onRequest);
    return () => window.removeEventListener("mmh:deposit:create", onRequest);
  }, []);

  // 弹窗挂载 + 账户数据到位后再补发一次，保证它注册的监听能收到，
  // 且收到时 accountId / 账户列表已经是可用状态。
  useEffect(() => {
    if (!openSignal || !pendingDetailRef.current || accounts.length === 0) return;
    const detail = pendingDetailRef.current;
    const timer = window.setTimeout(() => {
      if (pendingDetailRef.current !== detail) return;
      pendingDetailRef.current = null;
      replayingRef.current = true;
      try {
        window.dispatchEvent(new CustomEvent("mmh:deposit:create", { detail }));
      } finally {
        replayingRef.current = false;
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [openSignal, accounts.length]);

  useEffect(() => {
    if (!mounted) return;
    let cancelled = false;
    void (async () => {
      const data = await fetchSettingsAccountData().catch(() => null);
      if (cancelled || !data) return;
      setAccounts(
        (data.accounts as SettingsAccountRecord[]).filter(
          (account) => account.isPlaceholder !== true && account.isActive !== false,
        ),
      );
      setNestedFieldData({
        groupId: (data.groups ?? []).map((group) => ({ id: group.id, name: group.name })),
        institutionId: (data.institutions ?? []).map((institution) => ({
          id: institution.id,
          name: institution.shortName?.trim() || institution.name,
          type: institution.type ?? "",
        })),
        counterpartyId: (data.counterparties ?? []).map((counterparty) => ({
          id: counterparty.id,
          name: counterparty.name,
        })),
        ownerId: (data.users ?? []).map((user) => ({ id: user.id, name: user.name })),
      } as Record<string, Array<{ id: string; name: string; type?: string }>>);
    })();
    return () => {
      cancelled = true;
    };
  }, [mounted]);

  const accountOptions = useMemo(() => accounts.map(toOption), [accounts]);
  const cashAccountOptions = useMemo(
    () =>
      accountOptions.filter(
        (option) =>
          option.kind === "cash" ||
          option.kind === "bank_debit" ||
          option.kind === "ewallet" ||
          option.kind === "bank_credit",
      ),
    [accountOptions],
  );
  const depositAccountOptions = useMemo(
    () =>
      accountOptions.filter(
        (option) => option.kind === "deposit" || option.investProductType === "deposit",
      ),
    [accountOptions],
  );

  if (!mounted) return null;

  return (
    <DepositFormModal
      mode="create"
      accountId={depositAccountOptions[0]?.id ?? ""}
      openSignal={openSignal}
      cashAccounts={cashAccountOptions}
      investmentAccounts={depositAccountOptions}
      cashAccountSSOptions={cashAccountOptions as SmartSelectOption[]}
      investmentAccountSSOptions={depositAccountOptions as SmartSelectOption[]}
      nestedFieldData={nestedFieldData}
      createAction={createAction}
      editAction={editAction}
    />
  );
}
