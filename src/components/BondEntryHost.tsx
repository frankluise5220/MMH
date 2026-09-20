"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { BondFormModal } from "@/components/BondFormModal";
import type { SmartSelectOption } from "@/components/SmartSelect";
import { buildAccountDisplayOption } from "@/lib/account-display";
import { getAccountLabelFieldsPreference } from "@/lib/client/appPreferences";
import { fetchSettingsAccountData } from "@/lib/client/settingsCache";

/**
 * 顶部「胶囊记账入口」的债券落地宿主。
 *
 * 入口（UnifiedEntryLauncher）只负责派发 `mmh:bond:create`，事件必须由页面挂载的
 * BondFormModal 消费。记账页与债券视图自带这个弹窗，账户页、保险页、计划任务页
 * 只放了入口没放弹窗，于是「债券」点了没反应。这里按需（第一次点入口时）拉一次
 * 设置里的账户数据并挂载弹窗，避免给这些页面增加首屏负担。
 *
 * 与 DepositEntryHost 同构：先记住请求、挂载后再补发一次，否则弹窗注册监听时
 * 事件已经派发过去了。
 */

/** 必须与 BondFormModal 里的 AccountOption 结构一致（同名字段、同可选性）。 */
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

/** 必须与 BondFormModal 里的 BondLotOption 结构一致。 */
type BondLotOption = {
  id: string;
  name: string;
  accountId: string;
  certificateIndex: number;
  startDate: string | null;
  maturityDate: string | null;
  annualRate: number | null;
  principal: number;
  status: "open" | "closed";
};

export function BondEntryHost({
  createAction,
  editAction,
}: {
  createAction: (formData: FormData) => Promise<{ ok: true } | { ok: false; error: string }>;
  editAction?: (formData: FormData) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const [mounted, setMounted] = useState(false);
  const [accounts, setAccounts] = useState<SettingsAccountRecord[]>([]);
  const [bondLots, setBondLots] = useState<BondLotOption[]>([]);
  const [openSignal, setOpenSignal] = useState(0);
  const pendingDetailRef = useRef<Record<string, unknown> | null>(null);
  // 补发期间要忽略自己派发出去的事件，否则会「补发 → 再次入队 → 再补发」无限循环。
  const replayingRef = useRef(false);
  const [nestedFieldData, setNestedFieldData] = useState<
    Record<string, Array<{ id: string; name: string; type?: string }>> | undefined
  >(undefined);

  // 只有用户真的点了债券入口才挂载，页面首屏不为这些账户数据买单。
  useEffect(() => {
    function onRequest(ev: Event) {
      if (replayingRef.current) return; // 这是我们自己补发的，交给弹窗消费
      const detail = (ev as CustomEvent<Record<string, unknown>>).detail ?? {};
      if (pendingDetailRef.current) return; // 已有一笔在等，别覆盖
      pendingDetailRef.current = detail;
      setMounted(true);
      setOpenSignal((n) => n + 1);
    }
    window.addEventListener("mmh:bond:create", onRequest);
    return () => window.removeEventListener("mmh:bond:create", onRequest);
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
        window.dispatchEvent(new CustomEvent("mmh:bond:create", { detail }));
      } finally {
        replayingRef.current = false;
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [openSignal, accounts.length]);

  // 存单下拉：付息/赎回/核销要指明所属存单（同一债单可能有多张存单）。
  // 每次打开入口都刷新一次，避免用上一次会话的旧本金。
  useEffect(() => {
    if (!mounted || !openSignal) return;
    let cancelled = false;
    void (async () => {
      const res = await fetch("/api/v1/bond/lots").catch(() => null);
      const data = res ? await res.json().catch(() => null) : null;
      if (cancelled || !data?.ok) return;
      setBondLots((data.lots ?? []) as BondLotOption[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [mounted, openSignal]);

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
  const bondAccountOptions = useMemo(
    () => accountOptions.filter((option) => option.investProductType === "bond"),
    [accountOptions],
  );

  if (!mounted) return null;

  return (
    <BondFormModal
      mode="create"
      accountId={bondAccountOptions[0]?.id ?? ""}
      openSignal={openSignal}
      cashAccounts={cashAccountOptions}
      investmentAccounts={bondAccountOptions}
      cashAccountSSOptions={cashAccountOptions as SmartSelectOption[]}
      investmentAccountSSOptions={bondAccountOptions as SmartSelectOption[]}
      bondLotOptions={bondLots}
      nestedFieldData={nestedFieldData}
      createAction={createAction}
      editAction={editAction}
    />
  );
}
