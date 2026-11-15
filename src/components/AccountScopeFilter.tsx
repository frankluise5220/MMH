"use client";

import { ChevronDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/lib/i18n";
import { accountTableCell } from "@/lib/account-display";
import { useAccountDisplaySettings } from "@/lib/client/account-display-settings";
import { accountCustomGroupKey, accountFilterGroupKey, accountFilterGroupLabel, UNGROUPED_GROUP_KEY } from "@/lib/account-kinds";
import {
  FUND_COMPANY_INSTITUTION_PREFIX,
  fundCompanyInstitutionId,
  parseFundCompanyInstitutionId,
} from "@/lib/fund-company-filter";

export type StatisticsAccountItem = {
  id: string;
  name: string;
  kind?: string | null;
  investProductType?: string | null;
  label?: string;
  isPlaceholder?: boolean | null;
  groupId?: string;
  /**
   * 自定义分组标签（`Account.accountGroup`，如「日常」「储蓄」），与 `groupId`
   * → `AccountGroup`（所有人）不是一个概念。账户菜单可按它分组。
   */
  accountGroup?: string | null;
  userId?: string | null;
  /** 币种/卡号用于按「账户显示格式」渲染并生成 hover。 */
  currency?: string | null;
  numberMasked?: string | null;
  Institution?: { id?: string; name: string; shortName?: string | null } | null;
};

export type StatisticsInstitutionItem = { id: string; name: string; type?: string | null };
export type StatisticsUserItem = { id: string; name: string };
export const CASH_INSTITUTION_ID = "__cash__";
// NOTE: `FUND_COMPANY_INSTITUTION_PREFIX` / `fundCompanyInstitutionId` /
// `parseFundCompanyInstitutionId` / `splitInstitutionSelection` are deliberately
// NOT re-exported here. Re-exporting a function from a `"use client"` module turns
// it into a client reference, so a server component importing it from here fails at
// runtime with "Attempted to call ... from the server". Import them directly from
// `@/lib/fund-company-filter` instead.

export type AccountScopeValue = {
  userIds: string[];
  institutionIds: string[];
  accountIds: string[];
  /**
   * 自定义分组（`Account.accountGroup` 标签，空标签用 `UNGROUPED_GROUP_KEY`）。
   * 统计/报表按「分组 → 账户集合」参与交集过滤；只影响筛选，不改任何聚合口径。
   */
  groupKeys?: string[];
};

type ScopeKind = "users" | "groups" | "institutions" | "accounts";

type Props = {
  allAccounts: StatisticsAccountItem[];
  allInstitutions?: StatisticsInstitutionItem[];
  allUsers?: StatisticsUserItem[];
  showAccountFilter?: boolean;
  /**
   * 是否显示「分组」下拉（位于「全部人员」右边）。默认显示；
   * 只按账户 id 过滤、不消费 `groupKeys` 的调用点要显式关掉，
   * 否则会出现「选了分组但列表不变」的假筛选。
   */
  showGroupFilter?: boolean;
  /** Fund company names shown as an extra group inside the institution menu. */
  fundCompanies?: string[];
  /** Subset of `fundCompanies` that no longer holds a position. Rendered as its own sub-group so the union list is not mistaken for a miscount. */
  clearedOnlyFundCompanies?: string[];
  value: AccountScopeValue;
  onChange: (next: AccountScopeValue) => void;
  /**
   * 紧凑模式：触发器窄一档（7.5rem 而不是 10rem）。
   * 给「一行要塞很多筛选控件」的工具栏用（设置 → 账户列表），默认关闭以免影响报表/统计页。
   */
  compact?: boolean;
};

export function AccountScopeFilter({
  allAccounts,
  allInstitutions = [],
  allUsers = [],
  showAccountFilter = true,
  showGroupFilter = true,
  fundCompanies = [],
  clearedOnlyFundCompanies = [],
  value,
  onChange,
  compact = false,
}: Props) {
  const { t } = useI18n();
  const displaySettings = useAccountDisplaySettings();
  const [openMenu, setOpenMenu] = useState<ScopeKind | null>(null);
  const menuAnchorRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0 });
  const groupKeys = value.groupKeys ?? [];
  const [draftUserIds, setDraftUserIds] = useState<string[]>(value.userIds);
  const [draftGroupKeys, setDraftGroupKeys] = useState<string[]>(groupKeys);
  const [draftInstitutionIds, setDraftInstitutionIds] = useState<string[]>(value.institutionIds);
  const [draftAccountIds, setDraftAccountIds] = useState<string[]>(value.accountIds);
  const draftUserIdsRef = useRef(draftUserIds);
  const draftGroupKeysRef = useRef(draftGroupKeys);
  const draftInstitutionIdsRef = useRef(draftInstitutionIds);
  const draftAccountIdsRef = useRef(draftAccountIds);

  const userIds = value.userIds;
  const institutionIds = value.institutionIds;
  const accountIds = value.accountIds;

  useEffect(() => {
    setDraftUserIds(value.userIds);
    setDraftGroupKeys(value.groupKeys ?? []);
    setDraftInstitutionIds(value.institutionIds);
    setDraftAccountIds(value.accountIds);
  }, [value.userIds, value.groupKeys, value.institutionIds, value.accountIds]);

  // Keep refs in sync with drafts after commit so the pointerdown handler
  // (which closes the open menu) reads the latest selection. Writing refs
  // during render is not allowed by react-hooks/refs.
  useEffect(() => {
    draftUserIdsRef.current = draftUserIds;
    draftGroupKeysRef.current = draftGroupKeys;
    draftInstitutionIdsRef.current = draftInstitutionIds;
    draftAccountIdsRef.current = draftAccountIds;
  }, [draftUserIds, draftGroupKeys, draftInstitutionIds, draftAccountIds]);

  const validAccounts = useMemo(() => allAccounts.filter((account) => account.name.trim() && account.isPlaceholder !== true), [allAccounts]);
  /** 账户的自定义分组键；空标签归到「未分组」哨兵。 */
  function groupKeyOf(account: StatisticsAccountItem) {
    const name = account.accountGroup?.trim() ?? "";
    return name || UNGROUPED_GROUP_KEY;
  }
  // 分组选项来自账簿里真实存在的标签（加上「未分组」），按名称排序，未分组排最后。
  const groupOptions = useMemo(() => {
    const names = Array.from(new Set(validAccounts.map((account) => account.accountGroup?.trim() ?? "")));
    const labeled = names.filter((name) => name.length > 0).sort((left, right) => left.localeCompare(right, "zh-Hans-CN"));
    const options = labeled.map((name) => ({
      key: name,
      label: name,
      count: validAccounts.filter((account) => groupKeyOf(account) === name).length,
    }));
    if (names.some((name) => name.length === 0)) {
      options.push({
        key: UNGROUPED_GROUP_KEY,
        label: t("settings.accounts.groupLabelNone"),
        count: validAccounts.filter((account) => groupKeyOf(account) === UNGROUPED_GROUP_KEY).length,
      });
    }
    return options;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validAccounts, t]);
  const groupFilteredAccounts = useMemo(() => validAccounts.filter((account) =>
    groupKeys.length === 0 || groupKeys.includes(groupKeyOf(account)),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [validAccounts, groupKeys]);
  const userFilteredAccounts = useMemo(() => groupFilteredAccounts.filter((account) =>
    userIds.length === 0 || (account.groupId && userIds.includes(account.groupId)),
  ), [groupFilteredAccounts, userIds]);
  const fundCompanyOptions = useMemo(() => Array.from(new Set(
    fundCompanies.map((name) => name.trim()).filter((name) => name.length > 0),
  )).sort((left, right) => left.localeCompare(right, "zh-Hans-CN")).map((name) => ({
    id: fundCompanyInstitutionId(name),
    name,
    type: "fund_company" as const,
  })), [fundCompanies]);
  // Fund managers split by whether they still hold anything. A cleared-only
  // manager produces an empty holdings table, so it must be visibly separated.
  const fundCompanyGroups = useMemo(() => {
    const clearedNames = new Set(clearedOnlyFundCompanies.map((name) => name.trim()).filter(Boolean));
    const holding: typeof fundCompanyOptions = [];
    const cleared: typeof fundCompanyOptions = [];
    for (const item of fundCompanyOptions) {
      (clearedNames.has(item.name) ? cleared : holding).push(item);
    }
    return [
      { key: "holding", title: t("statistics.fundCompanyHolding"), items: holding },
      { key: "cleared", title: t("statistics.fundCompanyClearedOnly"), items: cleared },
    ].filter((group) => group.items.length > 0);
  }, [fundCompanyOptions, clearedOnlyFundCompanies, t]);
  const institutionOptions = useMemo(() => {
    const ids = new Set(userFilteredAccounts.map((account) => account.Institution?.id).filter(Boolean));
    const dedupeNames = new Set(fundCompanyOptions.map((item) => item.name));
    const options = (allInstitutions.length > 0 ? allInstitutions : Array.from(new Map(validAccounts.filter((a) => a.Institution?.id).map((a) => [a.Institution!.id!, { id: a.Institution!.id!, name: a.Institution!.name, type: null }])).values())).filter((institution) => ids.has(institution.id)
      // Names shown in the dedicated fund-company group are hidden here to avoid duplicates.
      && !(institution.type === "fund_company" && dedupeNames.has(institution.name.trim())));
    if (userFilteredAccounts.some((account) => !account.Institution?.id)) options.push({ id: CASH_INSTITUTION_ID, name: t("statistics.cashInstitution"), type: "cash" });
    return options;
  }, [validAccounts, allInstitutions, userFilteredAccounts, fundCompanyOptions, t]);
  // Fund-company selections carry no accounts of their own (they filter the
  // report rows instead), so they must not shrink the account option list.
  const realInstitutionIds = useMemo(
    () => institutionIds.filter((id) => !id.startsWith(FUND_COMPANY_INSTITUTION_PREFIX)),
    [institutionIds],
  );
  const accountOptions = useMemo(() => [...userFilteredAccounts.filter((account) =>
    realInstitutionIds.length === 0 || realInstitutionIds.some((id) => id === (account.Institution?.id ?? CASH_INSTITUTION_ID)),
  )].sort((left, right) => {
    const institutionCompare = (left.Institution?.name ?? "").localeCompare(right.Institution?.name ?? "", "zh-CN");
    if (institutionCompare !== 0) return institutionCompare;
    return (left.label ?? left.name).localeCompare(right.label ?? right.name, "zh-CN");
  }), [userFilteredAccounts, realInstitutionIds]);
  const userOptions = allUsers;

  // 机构触发器宽度 = 最长机构名（含「全部机构」占位）的文本宽度 + 图标/内边距。
  // 用 canvas 量一次（字号跟随 text-xs 的 12px），量不出来就退回 CSS 的内容宽度，
  // 上限 208px（`max-w-52`），超长机构名仍走省略号。
  const institutionLabels = useMemo(
    () => [
      t("statistics.allInstitutions"),
      ...institutionOptions.map((institution) => institution.name),
      ...fundCompanyOptions.map((item) => item.name),
    ],
    [t, institutionOptions, fundCompanyOptions],
  );
  const [institutionTriggerWidth, setInstitutionTriggerWidth] = useState<number | null>(null);
  useEffect(() => {
    const context = document.createElement("canvas").getContext("2d");
    if (!context) return;
    const fontFamily = getComputedStyle(document.body).fontFamily || "sans-serif";
    context.font = `12px ${fontFamily}`;
    const widest = institutionLabels.reduce((max, label) => Math.max(max, context.measureText(label).width), 0);
    // px-2.5(20) + gap(8) + chevron(14) + border(2)
    setInstitutionTriggerWidth(Math.min(Math.ceil(widest) + 44, 208));
  }, [institutionLabels]);

  useEffect(() => {
    if (!openMenu) return;
    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || menuAnchorRef.current?.contains(target)) return;
      const currentMenu = openMenu;
      const nextUserIds = draftUserIdsRef.current;
      const nextGroupKeys = draftGroupKeysRef.current;
      const nextInstitutionIds = draftInstitutionIdsRef.current;
      const nextAccountIds = draftAccountIdsRef.current;
      if (currentMenu === "users") onChange({ userIds: nextUserIds, groupKeys, institutionIds, accountIds });
      if (currentMenu === "groups") onChange({ userIds, groupKeys: nextGroupKeys, institutionIds, accountIds });
      if (currentMenu === "institutions") onChange({ userIds, groupKeys, institutionIds: nextInstitutionIds, accountIds });
      if (currentMenu === "accounts") onChange({ userIds, groupKeys, institutionIds, accountIds: nextAccountIds });
      setOpenMenu(null);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  // The handler intentionally reads the current draft selection when the menu closes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openMenu]);

  // The menu is rendered via createPortal to <body>, so `position: fixed` coordinates
  // are relative to the viewport. Keep them in sync with the trigger button on scroll
  // and resize (e.g. inside a sticky header that moves as the page scrolls).
  useEffect(() => {
    if (!openMenu) return;
    const activeKind = openMenu;
    function reposition() {
      positionMenu(activeKind);
    }
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [openMenu]);

  function selectSingle(kind: ScopeKind, id: string) {
    if (kind === "users") {
      const validAccountIds = accountIds.filter((accountIdValue) => allAccounts.some((account) => account.id === accountIdValue && account.groupId === id));
      setDraftUserIds([id]);
      setDraftAccountIds(validAccountIds);
      setOpenMenu(null);
      onChange({ userIds: [id], groupKeys, institutionIds, accountIds: validAccountIds });
    }
    if (kind === "groups") {
      // 点分组里的账户等于「按这个分组筛」，顺手把不匹配的账户选择收掉。
      const validAccountIds = accountIds.filter((accountIdValue) => allAccounts.some((account) => account.id === accountIdValue && accountCustomGroupKey(account) === id));
      setDraftGroupKeys([id]);
      setDraftAccountIds(validAccountIds);
      setOpenMenu(null);
      onChange({ userIds, groupKeys: [id], institutionIds, accountIds: validAccountIds });
    }
    if (kind === "institutions") {
      if (id.startsWith(FUND_COMPANY_INSTITUTION_PREFIX)) {
        setDraftInstitutionIds([id]);
        setOpenMenu(null);
        onChange({ userIds, groupKeys, institutionIds: [id], accountIds });
        return;
      }
      const validAccountIds = accountIds.filter((accountIdValue) => validAccounts.some((account) => account.id === accountIdValue && account.Institution?.id === id));
      setDraftInstitutionIds([id]);
      setDraftAccountIds(validAccountIds);
      setOpenMenu(null);
      onChange({ userIds, groupKeys, institutionIds: [id], accountIds: validAccountIds });
    }
    if (kind === "accounts") {
      setDraftAccountIds([id]);
      setOpenMenu(null);
      onChange({ userIds, groupKeys, institutionIds, accountIds: [id] });
    }
  }

  function confirm(kind: ScopeKind) {
    if (kind === "users") {
      const valid = draftAccountIds.filter((id) => allAccounts.some((account) => account.id === id && (draftUserIds.length === 0 || (account.groupId && draftUserIds.includes(account.groupId))) && (institutionIds.length === 0 || institutionIds.includes(account.Institution?.id ?? "")) && (groupKeys.length === 0 || groupKeys.includes(accountCustomGroupKey(account)))));
      setDraftAccountIds(valid);
      setOpenMenu(null);
      onChange({ userIds: draftUserIds, groupKeys, institutionIds, accountIds: valid });
    }
    if (kind === "groups") {
      // 分组条件收紧后，原账户多选里落在范围外的要一起收掉，避免两个维度打架。
      const allGroups = draftGroupKeys.length === 0;
      const nextAccount = draftAccountIds.filter((id) => allAccounts.some((account) =>
        account.id === id
        && (allGroups || draftGroupKeys.includes(accountCustomGroupKey(account)))
        && (userIds.length === 0 || (account.groupId && userIds.includes(account.groupId)))
        && (institutionIds.length === 0 || institutionIds.includes(account.Institution?.id ?? "")),
      ));
      setDraftAccountIds(nextAccount);
      setOpenMenu(null);
      onChange({ userIds, groupKeys: draftGroupKeys, institutionIds, accountIds: nextAccount });
    }
    if (kind === "institutions") {
      const next = draftInstitutionIds;
      const realIds = next.filter((id) => !id.startsWith(FUND_COMPANY_INSTITUTION_PREFIX));
      const nextAccount = draftAccountIds.filter((id) => allAccounts.some((account) =>
        account.id === id && (realIds.length === 0 || realIds.includes(account.Institution?.id ?? "")) && (userIds.length === 0 || (account.groupId && userIds.includes(account.groupId))) && (groupKeys.length === 0 || groupKeys.includes(accountCustomGroupKey(account))),
      ));
      setDraftAccountIds(nextAccount);
      setOpenMenu(null);
      onChange({ userIds, groupKeys, institutionIds: next, accountIds: nextAccount });
    }
    if (kind === "accounts") {
      setOpenMenu(null);
      onChange({ userIds, groupKeys, institutionIds, accountIds: draftAccountIds });
    }
  }

  function toggleDraft(kind: ScopeKind, id: string) {
    if (kind === "groups") {
      setDraftGroupKeys((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
      return;
    }
    const setter = kind === "users" ? setDraftUserIds : kind === "institutions" ? setDraftInstitutionIds : setDraftAccountIds;
    setter((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  }

  function toggleInstitutionType(type: string) {
    const ids = institutionOptions.filter((institution) => institutionGroupKey(institution.type) === type).map((institution) => institution.id);
    setDraftInstitutionIds((current) => ids.every((id) => current.includes(id))
      ? current.filter((id) => !ids.includes(id))
      : [...new Set([...current, ...ids])]);
  }

  function toggleFundCompanyGroup() {
    const ids = fundCompanyOptions.map((item) => item.id);
    setDraftInstitutionIds((current) => ids.every((id) => current.includes(id))
      ? current.filter((id) => !ids.includes(id))
      : [...new Set([...current, ...ids])]);
  }

  /** Grouping key for the account menu: investment accounts group by product
   *  category (fund/wealth/stock/property/...), everything else by account kind.
   *  Shared with the scheduled-task account filter so both pickers group alike. */
  function accountGroupKey(account: StatisticsAccountItem) {
    return accountFilterGroupKey(account);
  }

  function accountGroupLabel(type: string) {
    return accountFilterGroupLabel(type, t);
  }

  function toggleAccountType(type: string) {
    const ids = accountOptions.filter((account) => accountGroupKey(account) === type).map((account) => account.id);
    setDraftAccountIds((current) => ids.every((id) => current.includes(id)) ? current.filter((id) => !ids.includes(id)) : [...new Set([...current, ...ids])]);
  }

  function clearSelection(kind: ScopeKind) {
    if (kind === "users") { setDraftUserIds([]); setOpenMenu(null); onChange({ userIds: [], groupKeys, institutionIds, accountIds }); }
    if (kind === "groups") { setDraftGroupKeys([]); setOpenMenu(null); onChange({ userIds, groupKeys: [], institutionIds, accountIds }); }
    if (kind === "institutions") { setDraftInstitutionIds([]); setOpenMenu(null); onChange({ userIds, groupKeys, institutionIds: [], accountIds }); }
    if (kind === "accounts") { setDraftAccountIds([]); setOpenMenu(null); onChange({ userIds, groupKeys, institutionIds, accountIds: [] }); }
  }

  function institutionGroupKey(type: string | null | undefined) {
    if (type === "cash") return "cash";
    if (type === "bank") return "bank";
    if (type === "payment") return "payment";
    if (type === "provident_fund") return "provident_fund";
    if (type === "brokerage" || type === "fund_company" || type === "investment") return "investment";
    return "other";
  }

  function institutionGroupLabel(type: string) {
    if (type === "cash") return t("statistics.cashInstitution");
    if (type === "bank") return t("institution.type.bank");
    if (type === "payment") return t("institution.type.payment");
    if (type === "provident_fund") return t("institution.type.provident_fund");
    if (type === "investment") return t("statistics.investmentInstitutions");
    return t("institution.type.other");
  }

  /** 人员/分组是单列菜单；机构/账户是「分组名 + 三列账户」的宽菜单。 */
  function menuWidthFor(kind: ScopeKind) {
    return kind === "institutions" || kind === "accounts" ? 620 : 224;
  }

  function positionMenu(kind: ScopeKind) {
    const button = menuAnchorRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const menuWidth = menuWidthFor(kind);
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - menuWidth - 8));
    const menuHeight = Math.min(window.innerHeight * 0.7, 520);
    const openUpward = rect.bottom + 4 + menuHeight > window.innerHeight - 8 && rect.top - 4 - menuHeight > 8;
    const top = openUpward ? rect.top - menuHeight - 4 : rect.bottom + 4;
    setMenuPosition({ left, top });
  }

  function toggleMenu(kind: ScopeKind, button: HTMLButtonElement) {
    if (openMenu === kind) {
      confirm(kind);
      return;
    }
    menuAnchorRef.current = button;
    // 在挂载弹层前先同步计算好位置，避免弹层以初始 {left:0, top:0} 闪现一帧
    // 再被 setMenuPosition 跳到正确位置。
    const rect = button.getBoundingClientRect();
    const menuWidth = menuWidthFor(kind);
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - menuWidth - 8));
    const menuHeight = Math.min(window.innerHeight * 0.7, 520);
    const openUpward = rect.bottom + 4 + menuHeight > window.innerHeight - 8 && rect.top - 4 - menuHeight > 8;
    const top = openUpward ? rect.top - menuHeight - 4 : rect.bottom + 4;
    setMenuPosition({ left, top });
    setOpenMenu(kind);
  }

  function selectionLabel(kind: ScopeKind, selected: string[]) {
    if (selected.length === 0) {
      if (kind === "users") return t("statistics.allPeople");
      if (kind === "groups") return t("statistics.allGroups");
      return kind === "institutions" ? t("statistics.allInstitutions") : t("reports.allAccounts");
    }
    const labels = selected.map((id) => {
      if (kind === "users") return allUsers.find((user) => user.id === id)?.name ?? id;
      if (kind === "groups") return groupOptions.find((group) => group.key === id)?.label ?? id;
      if (kind === "institutions") return institutionOptions.find((institution) => institution.id === id)?.name
        ?? fundCompanyOptions.find((item) => item.id === id)?.name
        ?? parseFundCompanyInstitutionId(id)
        ?? id;
      const account = allAccounts.find((item) => item.id === id);
      return accountLabel(account);
    });
    if (labels.length > 1 && kind !== "users") {
      const key = kind === "groups" ? "statistics.selectedGroupsSummary" : kind === "institutions" ? "statistics.selectedInstitutionsSummary" : "statistics.selectedAccountsSummary";
      return t(key, { first: labels[0], count: labels.length });
    }
    return labels.join(", ");
  }

  // 筛选器也走「账户显示格式」：手拼 `机构·名称` 会忽略用户配置，也没有 hover。
  function accountCell(account: StatisticsAccountItem | StatisticsUserItem | undefined) {
    if (!account) return { label: "", title: "" };
    if (!("Institution" in account)) return { label: account.name, title: "" };
    return accountTableCell(
      {
        id: account.id,
        name: account.name,
        kind: account.kind ?? "other",
        numberMasked: account.numberMasked,
        currency: account.currency,
        Institution: account.Institution,
      },
      displaySettings,
    );
  }

  function accountLabel(account: StatisticsAccountItem | StatisticsUserItem | undefined) {
    return accountCell(account).label;
  }

  function accountTitle(account: StatisticsAccountItem | StatisticsUserItem | undefined) {
    const cell = accountCell(account);
    return cell.title || cell.label;
  }

  // 顺序固定为 人员 → 分组 → 机构 → 账户（分组紧跟人员，用户 2026-11-15 指定）。
  const filterKinds: ScopeKind[] = ["users"];
  if (showGroupFilter) filterKinds.push("groups");
  filterKinds.push("institutions");
  if (showAccountFilter) filterKinds.push("accounts");

  /**
   * 触发器宽度策略：
   * - 机构：按「最长机构名」定宽（`--mmh-inst-trigger-w`），上限 13rem —— 「全部机构」只有 4 个字，
   *   固定 7.5rem 会撑出一大片留白；而宽度恒定取最长名，切换选项时按钮不会左跳右跳。
   * - 人员：「全部人员」只有 4 个字，原来固定 10rem 白占一大截（2026-11-15 收到 6.5rem）。
   * - 账户：账户名普遍更长，保持原来的固定档位。
   */
  const triggerWidthClass = (kind: ScopeKind) => {
    if (kind === "institutions") return "md:min-w-[var(--mmh-inst-trigger-w,0px)] md:max-w-52";
    if (kind === "users" || kind === "groups") return compact ? "md:min-w-[6rem]" : "md:min-w-[6.5rem] md:max-w-44";
    return compact ? "md:min-w-[7.5rem] md:max-w-44" : "md:min-w-40 md:max-w-56";
  };

  // 「机构 / 账户」菜单一行一个分组，行距收紧一档（原来 min-h-7 + py-1 太高）。
  const menuGroupShellClass = "grid grid-cols-[96px_1fr] items-start gap-2 border-b border-slate-200 py-1.5 last:border-b-0";
  const menuGroupLabelClass = "flex min-h-6 items-center gap-1.5 px-2 text-xs font-medium text-slate-600";
  const menuGroupGridClass = "grid grid-cols-3 items-start gap-x-2 gap-y-0.5";
  const menuOptionRowClass = "flex min-h-6 min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-xs hover:bg-slate-50";

  type MenuGroup = { key: string; label: string; ids: string[] };

  const institutionMenuGroups: MenuGroup[] = Array.from(new Set(institutionOptions.map((institution) => institutionGroupKey(institution.type))))
    .map((type) => ({
      key: type,
      label: institutionGroupLabel(type),
      ids: institutionOptions.filter((institution) => institutionGroupKey(institution.type) === type).map((institution) => institution.id),
    }));

  // 账户菜单按账户类型分组（现金/信用卡/投资…）。按自定义分组标签做筛选是
  // 独立的一档（`groups`），不塞进这个菜单，避免同一件事两个入口。
  const accountMenuGroups: MenuGroup[] = Array.from(new Set(accountOptions.map((account) => accountGroupKey(account))))
    .map((type) => ({
      key: type,
      label: accountGroupLabel(type),
      ids: accountOptions.filter((account) => accountGroupKey(account) === type).map((account) => account.id),
    }));

  function renderMenuGroups(params: {
    groups: MenuGroup[];
    selectedIds: string[];
    onToggleGroup: (group: MenuGroup) => void;
    onToggleItem: (id: string) => void;
    itemLabel: (id: string) => string;
    itemTitle: (id: string) => string;
    onPick: (id: string) => void;
  }) {
    return params.groups.map((group) => (
      <div key={group.key} className={menuGroupShellClass}>
        <label className={menuGroupLabelClass}>
          <input type="checkbox" checked={group.ids.every((id) => params.selectedIds.includes(id))} onChange={() => params.onToggleGroup(group)} />
          {group.label}
        </label>
        <div className={menuGroupGridClass}>
          {group.ids.map((id) => (
            <div key={id} className={menuOptionRowClass}>
              <input type="checkbox" className="shrink-0" checked={params.selectedIds.includes(id)} onChange={() => params.onToggleItem(id)} />
              <button type="button" className="min-w-0 flex-1 truncate text-left" title={params.itemTitle(id)} onClick={() => params.onPick(id)}>{params.itemLabel(id)}</button>
            </div>
          ))}
        </div>
      </div>
    ));
  }

  const fundCompanyGroupBlock = fundCompanyOptions.length === 0 ? null : (
    <div className={menuGroupShellClass}>
      <label className={menuGroupLabelClass}>
        <input
          type="checkbox"
          checked={fundCompanyOptions.every((item) => draftInstitutionIds.includes(item.id))}
          onChange={toggleFundCompanyGroup}
        />
        {t("statistics.fundCompanies")}
      </label>
      <div className="space-y-1">
        {fundCompanyGroups.map((group) => (
          <div key={group.key}>
            <div className="px-1 pb-0.5 text-[11px] font-medium text-slate-400">
              {group.title}（{group.items.length}）
            </div>
            <div className={menuGroupGridClass}>
              {group.items.map((item) => (
                <div key={item.id} className={menuOptionRowClass}>
                  <input
                    type="checkbox"
                    className="shrink-0"
                    checked={draftInstitutionIds.includes(item.id)}
                    onChange={() => toggleDraft("institutions", item.id)}
                  />
                  <button
                    type="button"
                    className={`min-w-0 flex-1 truncate text-left ${group.key === "cleared" ? "text-slate-500" : ""}`}
                    title={item.name}
                    onClick={() => selectSingle("institutions", item.id)}
                  >{item.name}</button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    // 四个触发器（人员/分组/机构/账户）在中等宽度的一行工具栏里放不下，
    // 不设 md:min-w-max：宁可换行，也不要撑破父容器被裁掉右边一截。
    <div className="flex flex-wrap items-center gap-2 md:gap-3">
      {filterKinds.map((kind) => {
        const isUsers = kind === "users";
        const isGroups = kind === "groups";
        const isInstitutions = kind === "institutions";
        const selected = isUsers ? userIds : isGroups ? groupKeys : isInstitutions ? institutionIds : accountIds;
        const draft = isUsers ? draftUserIds : isGroups ? draftGroupKeys : isInstitutions ? draftInstitutionIds : draftAccountIds;
        const items = isInstitutions ? institutionOptions : isUsers ? userOptions : accountOptions;
        const isWideMenu = isInstitutions || kind === "accounts";
        const emptyHint = isGroups ? t("statistics.noGroups") : t("table.empty");
        const menuTitle = isUsers ? t("statistics.allPeople") : isGroups ? t("statistics.allGroups") : isInstitutions ? t("statistics.allInstitutions") : t("reports.allAccounts");
        return <div key={kind} className="relative shrink-0">
          <button type="button" title={selectionLabel(kind, selected)} aria-haspopup="listbox" aria-expanded={openMenu === kind} style={isInstitutions && institutionTriggerWidth ? ({ "--mmh-inst-trigger-w": `${institutionTriggerWidth}px` } as CSSProperties) : undefined} className={`inline-flex h-9 min-w-0 flex-1 items-center justify-between gap-2 rounded-md border border-slate-300 bg-white px-2.5 text-left text-xs text-slate-700 shadow-sm hover:border-slate-400 md:h-8 md:flex-none ${triggerWidthClass(kind)}`} onClick={(event) => toggleMenu(kind, event.currentTarget)}>
            <span className="truncate">{selectionLabel(kind, selected)}</span>
            <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${openMenu === kind ? "rotate-180" : ""}`} />
          </button>
          {openMenu === kind && createPortal(<div ref={menuRef} style={{ left: menuPosition.left, top: menuPosition.top }} className={`fixed z-[100] max-h-[min(70vh,520px)] overflow-y-auto rounded-md ${isWideMenu ? "w-[620px]" : "w-56"} border border-slate-200 bg-white p-2 shadow-lg`}>
            <div className="mb-1 flex items-center gap-2 px-2">
              <span className="text-[11px] font-medium text-slate-500">{menuTitle}</span>
              <button type="button" className="ml-auto text-[11px] text-blue-600 hover:text-blue-800" onClick={() => clearSelection(kind)}>{t("statistics.clearSelection")}</button>
            </div>
            {selected.length === 0 && isGroups && groupOptions.length > 0 && (
              <div className="px-2 pb-1 text-[11px] text-slate-400">{t("statistics.groupFilterHint")}</div>
            )}
            {(!isGroups && items.length === 0) || (isGroups && groupOptions.length === 0) ? <div className="px-2 py-2 text-xs text-slate-400">{emptyHint}</div> : null}
            {isInstitutions
              ? renderMenuGroups({
                  groups: institutionMenuGroups,
                  selectedIds: draftInstitutionIds,
                  onToggleGroup: (group) => toggleInstitutionType(group.key),
                  onToggleItem: (id) => toggleDraft("institutions", id),
                  itemLabel: (id) => institutionOptions.find((institution) => institution.id === id)?.name ?? id,
                  itemTitle: (id) => institutionOptions.find((institution) => institution.id === id)?.name ?? id,
                  onPick: (id) => selectSingle("institutions", id),
                })
              : kind === "accounts"
                ? renderMenuGroups({
                    groups: accountMenuGroups,
                    selectedIds: draftAccountIds,
                    onToggleGroup: (group) => toggleAccountType(group.key),
                    onToggleItem: (id) => toggleDraft("accounts", id),
                    itemLabel: (id) => accountLabel(accountOptions.find((account) => account.id === id)),
                    itemTitle: (id) => accountTitle(accountOptions.find((account) => account.id === id)),
                    onPick: (id) => selectSingle("accounts", id),
                  })
                : isGroups
                  ? groupOptions.map((group) => (
                      <div key={group.key} className="flex min-h-6 items-center gap-1.5 rounded px-2 py-0.5 text-xs hover:bg-slate-50">
                        <input type="checkbox" className="shrink-0" checked={draftGroupKeys.includes(group.key)} onChange={() => toggleDraft("groups", group.key)} />
                        <button type="button" className="min-w-0 flex-1 truncate text-left" title={group.label} onClick={() => selectSingle("groups", group.key)}>{group.label}</button>
                        <span className="shrink-0 text-[11px] tabular-nums text-slate-400">{group.count}</span>
                      </div>
                    ))
                  : items.map((item) => <div key={item.id} className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-slate-50">
                      <input type="checkbox" checked={draft.includes(item.id)} onChange={() => toggleDraft(kind, item.id)} />
                      <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => selectSingle(kind, item.id)}>{allUsers.find((user) => user.id === item.id)?.name ?? item.id}</button>
                    </div>)}
            {isInstitutions ? fundCompanyGroupBlock : null}
            <div className="sticky bottom-0 mt-1 border-t border-slate-200 bg-white pt-1.5">
              <button type="button" className="h-7 w-full rounded bg-slate-900 px-3 text-xs font-medium text-white hover:bg-slate-700" onClick={() => confirm(kind)}>{t("table.confirm")}</button>
            </div>
          </div>, document.body)}
        </div>;
      })}
    </div>
  );
}
