"use client";

/**
 * 绑定货币基金弹窗——「钱包挂货基代码、按日结收益」的唯一入口（2026-11-19 用户裁定）。
 *
 * 入口在**电子钱包视图的表头**，所以弹窗永远只针对「当前这只钱包」：不再给电子钱包
 * 下拉框（2026-11-19 用户裁定「既然是在电子钱包视图，那就应该是针对该账户的绑定」），
 * 顶部只显示这只钱包的身份。
 *
 * 弹窗里就一张表：每行是一段绑定，计息日期、退出日期、货基代码都能直接改，改完点行尾
 * 「确定」提交（2026-11-19 用户要求）；表格最下面留一个空行用来新增一段。改段会连带清掉
 * 该段旧区间的收益行，明细里不会同时出现两只基金的收益。
 *
 * 保存绑定/改段**不自动重算历史**（2026-11-24 用户裁定）：历史收益只在用户点下面的
 * 「重算」按钮时生成；当天的自动结转与开机自检照常按天继续结，不受影响。
 * 收益本身由 src/lib/server/wallet-money-fund-income.ts 计算，这里只发请求。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Info, Trash2, Wallet, X } from "lucide-react";
import { ModalLayer } from "@/components/ModalLayer";
import { accountOptionFromParts } from "@/lib/account-display";
import { readAccountDisplaySettings } from "@/lib/client/account-display-settings";
import { showChoiceDialog, showConfirmDialog } from "@/lib/client/confirm-dialog";
import { ALIPAY_BALANCE_BAO_FUNDS } from "@/lib/fund/money-fund-catalog";
import { todayDateLocalYmd } from "@/lib/date-utils";
import { useI18n } from "@/lib/i18n";

const FIELD_LABEL_CLS = "text-[11px] font-medium text-slate-500";
const FIELD_INPUT_CLS =
  "h-[var(--field-h-compact)] w-full rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-800 outline-none transition-colors hover:border-slate-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-100";
const TH_CLS = "border-b border-slate-200 px-2 py-1.5 text-left text-[11px] font-semibold text-slate-600";
const TD_CLS = "border-b border-slate-100 px-2 py-1 align-middle text-xs";
/** 表格行内的编辑框：比 .form-input 矮一档，行高才跟纯文本行对得上。 */
const CELL_INPUT_CLS =
  "h-6 w-full min-w-0 rounded border border-slate-300 bg-white px-1 text-[11px] tabular-nums text-slate-700 outline-none transition-colors hover:border-slate-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-100";

/** 当前视图里的那只电子钱包（入口在它的视图表头，所以弹窗不选账户）。 */
export type MoneyFundWalletAccount = {
  id: string;
  name: string;
  kind: string;
  institutionName?: string | null;
  institutionShortName?: string | null;
  numberMasked?: string | null;
  currency?: string | null;
  isActive?: boolean;
  linkedFundCode?: string | null;
  linkedFundStartDate?: string | null;
};

/** 服务端 /api/v1/accounts/linked-funds 返回的一段绑定。 */
type LinkedFundSegment = {
  id: string;
  accountId: string;
  fundCode: string;
  fundName: string | null;
  /** YYYY-MM-DD（含）。 */
  startDate: string;
  /** YYYY-MM-DD（含）；null = 当前生效。 */
  endDate: string | null;
  note: string | null;
};

/** 表格一行的编辑值（字符串形态，空字符串 = 未填）。 */
type SegmentDraft = {
  startDate: string;
  endDate: string;
  fundCode: string;
};

const EMPTY_DRAFT: SegmentDraft = { startDate: "", endDate: "", fundCode: "" };
/** 新增行的 savingId：与已有段的 id 区分开。 */
const NEW_ROW_KEY = "new";

/**
 * 绑定历史按账户缓存一屏（module 级，跨弹窗开关保留）。
 *
 * 这张表只有几行，改动都发生在弹窗自己的写操作里（写完会回写缓存），所以
 * 「先渲染上次结果 + 后台静默刷新」比每次打开都空等一次接口稳得多。
 */
const segmentsCache = new Map<string, LinkedFundSegment[]>();
/** 同一账户正在飞的预热请求：hover 连点时只发一次。 */
const segmentsInflight = new Map<string, Promise<void>>();

/**
 * 货基代码 → 基金名称（module 级缓存）：弹窗开了又关、同一代码多次输入都只查一次。
 * 名称是「输入」的产物，不是列表数据，所以不放进 segmentsCache。
 */
const fundNameCache = new Map<string, string>();
/** 同一代码正在飞的名字查询：连续补查只发一次请求。 */
const fundNameInflight = new Map<string, Promise<string>>();

/** 内置名单里本来就有名字的（余额宝那几只），不必问接口。 */
function catalogFundName(code: string) {
  return ALIPAY_BALANCE_BAO_FUNDS.find((fund) => fund.code === code)?.name ?? "";
}

/**
 * 按代码查基金名称（GET /api/v1/fund/name：FundProfile → 外部身份接口）。
 *
 * 内置名单只是输入建议，用户完全可以填名单外的货基（2026-11-20 用户报：015651 名称
 * 一直是空的）。查不到返回空字符串，由调用方决定怎么显示，不抛错。
 */
async function fetchFundName(code: string): Promise<string> {
  const trimmed = code.trim();
  if (!/^\d{6}$/.test(trimmed)) return "";
  const known = catalogFundName(trimmed) || fundNameCache.get(trimmed) || "";
  if (known) return known;
  let task = fundNameInflight.get(trimmed);
  if (!task) {
    task = fetch(`/api/v1/fund/name?code=${encodeURIComponent(trimmed)}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { ok?: boolean; name?: unknown } | null) => {
        const name = typeof data?.name === "string" ? data.name.trim() : "";
        return data?.ok === true ? name : "";
      })
      .catch(() => "")
      .finally(() => fundNameInflight.delete(trimmed));
    fundNameInflight.set(trimmed, task);
  }
  const name = await task;
  if (name) fundNameCache.set(trimmed, name);
  return name;
}

/** 拉一次段列表；失败返回 null（调用方据此决定是清空还是留着缓存）。 */
async function fetchSegmentList(accountId: string): Promise<LinkedFundSegment[] | null> {
  try {
    const response = await fetch(`/api/v1/accounts/linked-funds?accountId=${encodeURIComponent(accountId)}`);
    const data = await response.json().catch(() => null) as
      | { ok?: boolean; data?: { segments?: LinkedFundSegment[] } }
      | null;
    if (!response.ok || data?.ok !== true) return null;
    return data.data?.segments ?? [];
  } catch {
    return null;
  }
}

/**
 * 预热：宿主按钮 hover / 聚焦时先拉一次，点开弹窗就直接命中缓存。
 *
 * 只填缓存，不碰任何组件状态，失败也不提示 —— 用户还没点开，没必要让他看见错误。
 */
export async function prefetchMoneyFundSegments(accountId: string) {
  if (!accountId || segmentsCache.has(accountId) || segmentsInflight.has(accountId)) return;
  const task = (async () => {
    const list = await fetchSegmentList(accountId);
    if (list) segmentsCache.set(accountId, list);
  })().finally(() => segmentsInflight.delete(accountId));
  segmentsInflight.set(accountId, task);
  await task;
}

type Props = {
  open: boolean;
  /** 这只钱包就是弹窗的唯一对象：账户信息在视图表头已经确定。 */
  account: MoneyFundWalletAccount;
  onClose: () => void;
  /** 绑定/换绑/结束/删除/重算成功后回调，由宿主刷新账户列表与视图。 */
  onChanged: (reason: string) => void;
};

function fundLabelOf(code: string) {
  const name = ALIPAY_BALANCE_BAO_FUNDS.find((fund) => fund.code === code)?.name;
  return name ? `${name} ${code}` : code;
}

/** 表格里的名称列：接口没给名字时退回内置货基名单（余额宝那几只）。 */
function fundNameOf(code: string, fallback?: string | null) {
  return (fallback ?? "").trim() || ALIPAY_BALANCE_BAO_FUNDS.find((fund) => fund.code === code)?.name || "";
}

/** 账户接口把日期序列化成 ISO（2026-01-01T00:00:00.000Z），这里只留日历日。 */
function toYmd(value?: string | null) {
  const matched = /^\d{4}-\d{2}-\d{2}/.exec((value ?? "").trim());
  return matched ? matched[0] : "";
}

function draftFromSegment(segment: LinkedFundSegment): SegmentDraft {
  return { startDate: segment.startDate, endDate: segment.endDate ?? "", fundCode: segment.fundCode };
}

/** 服务端错误码 → i18n key（与 wallet-linked-fund-periods 的 WALLET_LINKED_FUND_ERROR 对应）。 */
function accountLinkedFundErrorKey(code: string | undefined) {
  switch (code) {
    case "ACCOUNT_LINKED_FUND_KIND": return "settings.accounts.linkedFund.errorKind";
    case "ACCOUNT_LINKED_FUND_CODE": return "settings.accounts.linkedFund.errorCode";
    case "ACCOUNT_LINKED_FUND_START_DATE": return "settings.accounts.linkedFund.errorBindDate";
    case "ACCOUNT_LINKED_FUND_END_DATE": return "settings.accounts.linkedFund.errorBindDate";
    case "ACCOUNT_LINKED_FUND_OVERLAP": return "settings.accounts.linkedFund.errorOverlap";
    default: return "";
  }
}

export function MoneyFundIncomeDialog({ open, account, onClose, onChanged }: Props) {
  const { t } = useI18n();
  const tf = (key: string, values: Record<string, string | number>) => {
    let text: string = t(key);
    for (const [name, value] of Object.entries(values)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
    return text;
  };

  /** 重算区间：默认「最近绑定的货基绑定日 → 今天」。 */
  const [recalcFrom, setRecalcFrom] = useState(() => todayDateLocalYmd());
  const [recalcTo, setRecalcTo] = useState(() => todayDateLocalYmd());
  /** 用户改过区间后，段列表回来不许再覆盖他填的日期。 */
  const recalcTouchedRef = useRef(false);
  const [segments, setSegments] = useState<LinkedFundSegment[]>([]);
  const [segmentsLoading, setSegmentsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  /** 每行未提交的编辑值；没有条目就表示这一行还是服务端的原值。 */
  const [drafts, setDrafts] = useState<Record<string, SegmentDraft>>({});
  /** 表格底部空行的输入值。 */
  const [newDraft, setNewDraft] = useState<SegmentDraft>(EMPTY_DRAFT);
  /** 正在提交的行（NEW_ROW_KEY = 新增行），只用来显示省略号。 */
  const [savingId, setSavingId] = useState<string | null>(null);
  /** 输入代码后查回来的名称（代码 → 名称）：段上没存名字时也能显示。 */
  const [lookupNames, setLookupNames] = useState<Record<string, string>>({});
  /** 正在查名称的代码：表格里显示「查询中…」，别让人以为「就是没有名字」。 */
  const [lookupPending, setLookupPending] = useState<Record<string, boolean>>({});

  /**
   * 补齐基金名称：输入满 6 位就查，保存前再兜一次（2026-11-20 用户要求）。
   *
   * 返回查到的名称（查不到是空字符串）。同一代码的并发调用共享同一个请求，
   * 命中缓存直接返回，不会因为点了「确定」又打一次接口。
   */
  const resolveFundName = useCallback(async (rawCode: string): Promise<string> => {
    const code = rawCode.trim();
    if (!/^\d{6}$/.test(code)) return "";
    const known = catalogFundName(code) || fundNameCache.get(code) || "";
    if (known) return known;
    setLookupPending((previous) => (previous[code] ? previous : { ...previous, [code]: true }));
    try {
      const name = await fetchFundName(code);
      if (name) {
        setLookupNames((previous) => (previous[code] === name ? previous : { ...previous, [code]: name }));
      }
      return name;
    } finally {
      if (!fundNameInflight.has(code)) {
        setLookupPending((previous) => {
          if (!previous[code]) return previous;
          const next = { ...previous };
          delete next[code];
          return next;
        });
      }
    }
  }, []);

  /** 名称列显示：段上存的名字 → 内置名单 → 这次查回来的名字。 */
  function displayFundName(code: string, fallback?: string | null) {
    return fundNameOf(code, fallback) || lookupNames[code.trim()] || "";
  }

  /** 顶部用于表明「在给哪只钱包挂货基」：账户标签与其他页面同口径。 */
  const accountLabel = useMemo(() => accountOptionFromParts({
    id: account.id,
    name: account.name,
    kind: account.kind,
    institutionName: account.institutionName ?? null,
    institutionShortName: account.institutionShortName ?? null,
    numberMasked: account.numberMasked ?? null,
    currency: account.currency ?? null,
  }, readAccountDisplaySettings()), [account]);

  /** 当前生效段：以区间表为准，老数据没有表记录时退回账户快照。 */
  const currentSegment = useMemo(
    () => segments.find((segment) => !segment.endDate) ?? null,
    [segments],
  );
  const boundCode = (currentSegment?.fundCode ?? account.linkedFundCode ?? "").trim();
  const boundStartDate = toYmd(currentSegment?.startDate ?? account.linkedFundStartDate);

  /** 表格按计息日期倒序（最近的在最上面），最新一段打绿色「激活」标识。 */
  const orderedSegments = useMemo(
    () => [...segments].sort((left, right) => right.startDate.localeCompare(left.startDate)),
    [segments],
  );


  // 只有最后一次请求的结果能落到 state：绑定/换绑连点时先发的响应可能后到。
  const segmentsRequestRef = useRef(0);
  const loadSegments = useCallback(async (accountId: string, options?: { silent?: boolean }) => {
    if (!accountId) {
      setSegments([]);
      return;
    }
    const requestId = segmentsRequestRef.current + 1;
    segmentsRequestRef.current = requestId;
    // 上次打开留下的结果先上屏，网络结果到了再替换：不再先白等一次接口。
    const cached = options?.silent ? undefined : segmentsCache.get(accountId);
    if (cached) {
      setSegments(cached);
      setSegmentsLoading(false);
    } else if (!options?.silent) {
      setSegmentsLoading(true);
    }
    try {
      const list = await fetchSegmentList(accountId);
      if (requestId !== segmentsRequestRef.current) return;
      if (list) {
        segmentsCache.set(accountId, list);
        setSegments(list);
      } else if (!cached) {
        setSegments([]);
      }
    } finally {
      if (requestId === segmentsRequestRef.current) setSegmentsLoading(false);
    }
  }, []);

  // 只在弹窗刚打开时初始化一次；之后账户刷新（保存/重算后）不能把用户填的东西清掉。
  const didInitRef = useRef(false);
  useEffect(() => {
    if (!open) {
      didInitRef.current = false;
      segmentsRequestRef.current += 1;
      return;
    }
    if (didInitRef.current) return;
    didInitRef.current = true;
    const startDate = toYmd(account.linkedFundStartDate) || todayDateLocalYmd();
    setRecalcFrom(startDate);
    setRecalcTo(todayDateLocalYmd());
    recalcTouchedRef.current = false;
    setDrafts({});
    setNewDraft(EMPTY_DRAFT);
    setMessage("");
    setError("");
    void loadSegments(account.id);
  }, [account.id, account.linkedFundStartDate, loadSegments, open]);

  /**
   * 默认区间 = 「最近绑定的那段」的起始日 → 今天。
   *
   * 段列表是异步回来的，账户快照可能是旧代码/旧起始日，所以以区间表的当前段为准；
   * 当前没有生效段（最新一段已经填了退出日期）时，用最新那一段的起始日 —— 否则
   * 用户会看到一个空起点、甚至整块「重算」都不显示。用户已经动过日期就不再覆盖。
   */
  useEffect(() => {
    if (!open || recalcTouchedRef.current) return;
    const latestStart = toYmd(orderedSegments[0]?.startDate);
    if (latestStart) setRecalcFrom(latestStart);
  }, [open, orderedSegments]);

  /**
   * 历史段的名字是空的（接口没带、或早于「按代码查名称」这条链路）→ 打开弹窗时补查。
   * resolveFundName 自带缓存与在飞合并，重复触发不会重复打接口。
   */
  useEffect(() => {
    if (!open || segments.length === 0) return;
    for (const segment of segments) {
      if ((segment.fundName ?? "").trim()) continue;
      void resolveFundName(segment.fundCode);
    }
  }, [open, resolveFundName, segments]);

  function draftOf(segment: LinkedFundSegment): SegmentDraft {
    return drafts[segment.id] ?? draftFromSegment(segment);
  }

  function patchDraft(segment: LinkedFundSegment, patch: Partial<SegmentDraft>) {
    setDrafts((previous) => ({
      ...previous,
      [segment.id]: { ...(previous[segment.id] ?? draftFromSegment(segment)), ...patch },
    }));
  }

  function isDirty(segment: LinkedFundSegment) {
    const draft = draftOf(segment);
    return draft.startDate !== segment.startDate
      || draft.endDate !== (segment.endDate ?? "")
      || draft.fundCode !== segment.fundCode;
  }

  /** 行内与新增行共用校验：代码 6 位、计息日必填、退出日不早于计息日。 */
  function validateDraft(draft: SegmentDraft) {
    if (!/^\d{6}$/.test(draft.fundCode.trim())) {
      setError(t("settings.accounts.linkedFund.errorCode"));
      return false;
    }
    if (!draft.startDate) {
      setError(t("settings.accounts.linkedFund.errorBindDate"));
      return false;
    }
    if (draft.endDate && draft.endDate < draft.startDate) {
      setError(t("settings.accounts.linkedFund.historyRangeInvalid"));
      return false;
    }
    return true;
  }

  /**
   * 改一段（segmentId 有值）或新增一段（null）：都走 PUT，服务端只维护区间表，
   * 不自动关旧段、不做买卖；区间重叠由服务端挡回来。
   */
  async function submitSegment(segmentId: string | null, draft: SegmentDraft) {
    if (busy) return;
    setBusy(true);
    setSavingId(segmentId ?? NEW_ROW_KEY);
    setMessage("");
    setError("");
    const fundCode = draft.fundCode.trim();
    // 名称和代码一起存：输入时的查询可能还没回来（用户手快直接点确定），这里再兜一次。
    const fundName = displayFundName(fundCode) || (await resolveFundName(fundCode));
    try {
      const response = await fetch("/api/v1/accounts/linked-funds", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: account.id,
          segmentId: segmentId ?? undefined,
          startDate: draft.startDate,
          endDate: draft.endDate || null,
          fundCode,
          fundName: fundName.trim() || null,
        }),
      });
      const data = await response.json().catch(() => null) as { ok?: boolean; code?: string; error?: string } | null;
      if (!response.ok || data?.ok !== true) {
        const key = accountLinkedFundErrorKey(data?.code);
        setError(key ? t(key) : (data?.error?.trim() || t("settings.accounts.linkedFund.bindFailed")));
        return;
      }
      if (segmentId) {
        setDrafts((previous) => {
          const next = { ...previous };
          delete next[segmentId];
          return next;
        });
        setMessage(tf("settings.accounts.linkedFund.historyUpdateDone", { start: draft.startDate }));
      } else {
        setNewDraft(EMPTY_DRAFT);
        setMessage(tf("settings.accounts.linkedFund.historyCreateDone", { start: draft.startDate }));
      }
      onChanged("account:linked-fund-segment-save");
      await loadSegments(account.id, { silent: true });
      // 保存段之后**不自动重算**（2026-11-24 用户裁定）：绑定/改段只是建立或修正区间，
      // 历史收益要不要生成、生成到哪一天，由用户点下面的「重算」决定。服务端已经把新旧
      // 区间里的旧收益行删掉并重算了余额，自动结转会从今天起按天继续结，不回补历史。
    } catch {
      setError(t("settings.accounts.linkedFund.bindFailed"));
    } finally {
      setBusy(false);
      setSavingId(null);
    }
  }

  function saveSegment(segment: LinkedFundSegment) {
    const draft = draftOf(segment);
    if (!validateDraft(draft)) return;
    void submitSegment(segment.id, draft);
  }

  function createSegment() {
    if (!validateDraft(newDraft)) return;
    void submitSegment(null, newDraft);
  }

  /**
   * 删除误绑的一段（2026-11-19 用户要求）：先问「这段已经生成的收益要删掉还是保留」。
   * 有收益时给两个按钮（删除收益 / 保留收益），没收益就是普通的二次确认。
   */
  async function deleteSegment(segment: LinkedFundSegment) {
    if (busy) return;
    let income = { days: 0, amount: 0 };
    try {
      const response = await fetch(
        `/api/v1/accounts/linked-funds?accountId=${encodeURIComponent(account.id)}&segmentId=${encodeURIComponent(segment.id)}`,
      );
      const data = await response.json().catch(() => null) as {
        ok?: boolean;
        data?: { income?: { days?: number; amount?: number } };
      } | null;
      if (response.ok && data?.ok === true) {
        income = { days: data.data?.income?.days ?? 0, amount: data.data?.income?.amount ?? 0 };
      }
    } catch {
      // 统计失败不影响删除：按「没有收益」问一句，服务端照旧按默认口径处理。
    }

    let keepIncome = false;
    if (income.days > 0) {
      const choice = await showChoiceDialog<"remove" | "keep">({
        title: t("settings.accounts.linkedFund.historyDeleteConfirmTitle"),
        message: tf("settings.accounts.linkedFund.historyDeleteChoice", {
          fund: fundLabelOf(segment.fundCode),
          days: income.days,
          amount: income.amount.toFixed(2),
        }),
        choices: [
          { value: "remove", label: t("settings.accounts.linkedFund.historyDeleteIncomeRemove"), tone: "danger" },
          { value: "keep", label: t("settings.accounts.linkedFund.historyDeleteIncomeKeep") },
        ],
        cancelLabel: t("common.cancel"),
      });
      if (!choice) return;
      keepIncome = choice === "keep";
    } else {
      const confirmed = await showConfirmDialog({
        title: t("settings.accounts.linkedFund.historyDeleteConfirmTitle"),
        message: tf("settings.accounts.linkedFund.historyDeleteConfirm", { fund: fundLabelOf(segment.fundCode) }),
        confirmLabel: t("settings.accounts.linkedFund.historyDelete"),
        cancelLabel: t("common.cancel"),
        tone: "danger",
      });
      if (!confirmed) return;
    }

    setBusy(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch(
        `/api/v1/accounts/linked-funds?accountId=${encodeURIComponent(account.id)}&segmentId=${encodeURIComponent(segment.id)}${keepIncome ? "&keepIncome=1" : ""}`,
        { method: "DELETE" },
      );
      const data = await response.json().catch(() => null) as {
        ok?: boolean;
        code?: string;
        error?: string;
        data?: { removedIncome?: number; keptIncome?: number };
      } | null;
      if (!response.ok || data?.ok !== true) {
        const key = accountLinkedFundErrorKey(data?.code);
        setError(key ? t(key) : (data?.error?.trim() || t("settings.accounts.linkedFund.unbindFailed")));
        return;
      }
      setMessage(
        keepIncome
          ? tf("settings.accounts.linkedFund.historyDeleteDoneKeep", { count: data.data?.keptIncome ?? 0 })
          : tf("settings.accounts.linkedFund.historyDeleteDone", { count: data.data?.removedIncome ?? 0 }),
      );
      await loadSegments(account.id, { silent: true });
      onChanged("account:linked-fund-segment-delete");
    } catch {
      setError(t("settings.accounts.linkedFund.unbindFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function recalc() {
    // 只要有钱包上任何一段绑定就能重算：重算按日期区间重放收益，跟「当前有没有生效段」无关。
    // （2026-11-20 用户报：第一次添加时看不到「重算」按钮——那段当时填了退出日期，
    // 当前段为空，旧条件 boundCode 就把它连区块一起藏了。）
    if (busy || segments.length === 0) return;
    const fromDate = recalcFrom || boundStartDate || todayDateLocalYmd();
    const toDate = recalcTo || todayDateLocalYmd();
    if (toDate < fromDate) {
      setMessage("");
      setError(t("settings.accounts.linkedFund.recalcRangeInvalid"));
      return;
    }
    const confirmed = await showConfirmDialog({
      title: t("settings.accounts.linkedFund.recalcConfirmTitle"),
      message: tf("settings.accounts.linkedFund.recalcConfirm", { from: fromDate, to: toDate }),
      confirmLabel: t("settings.accounts.linkedFund.recalc"),
    });
    if (!confirmed) return;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch("/api/v1/fund/money-income/accrue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.id, fromDate, toDate }),
      });
      const data = await response.json().catch(() => null) as {
        ok?: boolean;
        error?: string;
        data?: { wallet?: { days?: number; totalIncome?: number; removed?: number } };
      } | null;
      if (!response.ok || data?.ok !== true) {
        setError(data?.error?.trim() || t("settings.accounts.linkedFund.recalcFailed"));
        return;
      }
      const wallet = data.data?.wallet;
      setMessage(tf("settings.accounts.linkedFund.recalcDone", {
        days: wallet?.days ?? 0,
        amount: (wallet?.totalIncome ?? 0).toFixed(2),
      }));
      onChanged("account:linked-fund-recalc");
    } catch {
      setError(t("settings.accounts.linkedFund.recalcFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  // 用户自己的日历（不缓存：跨零点还开着的页面要跟着走）。
  const todayYmd = todayDateLocalYmd();

  return (
    <ModalLayer
      className="fixed inset-0 flex items-center justify-center bg-black/30 p-4 backdrop-blur-[1px]"
      onMouseDown={onClose}
    >
      <div
        className="w-[640px] max-w-[calc(100vw-2rem)] rounded-xl border border-slate-200 bg-white shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <div className="flex items-center gap-1 text-sm font-semibold text-slate-800">
            <span>{t("settings.accounts.moneyFund.title")}</span>
            <span
              className="inline-flex shrink-0 cursor-help items-center text-slate-400"
              role="img"
              title={t("settings.accounts.linkedFund.hint")}
              aria-label={t("settings.accounts.linkedFund.hint")}
            >
              <Info className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
            aria-label={t("common.close")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid gap-3 px-4 py-3">
          {/* 账户身份：入口在钱包视图表头，所以固定显示这只钱包，不再给下拉框。 */}
          <div
            className="flex items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50/70 px-2 py-1.5"
            title={accountLabel.title}
          >
            <Wallet className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
            <span className="min-w-0 truncate text-xs font-medium text-slate-700">{accountLabel.label}</span>
            {account.isActive === false ? (
              <span className="shrink-0 rounded bg-slate-200/70 px-1 py-px text-[10px] text-slate-500">
                {t("settings.accounts.moneyFund.inactiveTag")}
              </span>
            ) : null}
          </div>

          <div className="grid gap-1">
            <label className={FIELD_LABEL_CLS}>{t("settings.accounts.linkedFund.historyTitle")}</label>
            <div className="max-h-56 overflow-auto rounded-md border border-slate-200" style={{ scrollbarGutter: "stable" }}>
              <table className="w-full border-collapse">
                <thead className="sticky top-0 z-10 bg-slate-50">
                  <tr>
                    <th className={`${TH_CLS} w-[112px] whitespace-nowrap`}>{t("settings.accounts.linkedFund.colStartDate")}</th>
                    <th
                      className={`${TH_CLS} w-[112px] whitespace-nowrap`}
                      title={t("settings.accounts.linkedFund.historyEditHint")}
                    >
                      {t("settings.accounts.linkedFund.colEndDate")}
                    </th>
                    <th className={`${TH_CLS} w-[78px] whitespace-nowrap`}>{t("settings.accounts.linkedFund.colFundCode")}</th>
                    <th className={TH_CLS}>{t("settings.accounts.linkedFund.colFundName")}</th>
                    <th className={`${TH_CLS} w-[64px] text-right whitespace-nowrap`}>{t("detail.column.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {orderedSegments.length === 0 && !segmentsLoading ? (
                    <tr>
                      <td colSpan={5} className="px-2 py-2 text-[11px] text-slate-500">
                        {t("settings.accounts.linkedFund.historyEmpty")}
                      </td>
                    </tr>
                  ) : null}
                  {orderedSegments.map((segment) => {
                    const draft = draftOf(segment);
                    const dirty = isDirty(segment);
                    const saving = savingId === segment.id;
                    const active = !draft.endDate;
                    const fundName = displayFundName(draft.fundCode, segment.fundName);
                    const lookupWaiting = Boolean(lookupPending[draft.fundCode.trim()]);
                    return (
                      <tr key={segment.id} className={dirty ? "bg-amber-50/60" : "hover:bg-slate-50"}>
                        <td className={TD_CLS}>
                          <input
                            type="date"
                            value={draft.startDate}
                            max={todayYmd}
                            onChange={(event) => patchDraft(segment, { startDate: event.target.value })}
                            className={CELL_INPUT_CLS}
                            aria-label={t("settings.accounts.linkedFund.colStartDate")}
                          />
                        </td>
                        <td className={TD_CLS}>
                          <input
                            type="date"
                            value={draft.endDate}
                            min={draft.startDate || undefined}
                            max={todayYmd}
                            onChange={(event) => patchDraft(segment, { endDate: event.target.value })}
                            className={CELL_INPUT_CLS}
                            aria-label={t("settings.accounts.linkedFund.colEndDate")}
                          />
                        </td>
                        <td className={TD_CLS}>
                          <input
                            value={draft.fundCode}
                            onChange={(event) => {
                              const code = event.target.value.replace(/[^\d]/g, "").slice(0, 6);
                              patchDraft(segment, { fundCode: code });
                              if (code.length === 6) void resolveFundName(code);
                            }}
                            placeholder={t("settings.accounts.linkedFund.fundCodePlaceholder")}
                            inputMode="numeric"
                            maxLength={6}
                            list="mmh-money-fund-code-suggestions"
                            className={CELL_INPUT_CLS}
                            aria-label={t("settings.accounts.linkedFund.colFundCode")}
                          />
                        </td>
                        <td className={TD_CLS}>
                          <div className="flex min-w-0 items-center gap-1">
                            <span
                              className={`min-w-0 truncate ${fundName ? "text-slate-800" : "text-slate-400"}`}
                              title={fundName || undefined}
                            >
                              {fundName || (lookupWaiting
                                ? t("settings.accounts.linkedFund.fundNameLookup")
                                : draft.fundCode.length === 6
                                  ? t("settings.accounts.linkedFund.fundNameNotFound")
                                  : "-")}
                            </span>
                            {active ? (
                              <span className="shrink-0 rounded bg-emerald-50 px-1 py-px text-[10px] font-medium text-emerald-700">
                                {t("settings.accounts.linkedFund.historyActive")}
                              </span>
                            ) : null}
                          </div>
                        </td>
                        <td className={`${TD_CLS} text-right`}>
                          <div className="flex items-center justify-end gap-1">
                            <button
                              type="button"
                              onClick={() => saveSegment(segment)}
                              disabled={busy || !dirty}
                              className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-blue-600 transition hover:bg-blue-50 disabled:cursor-not-allowed disabled:text-slate-300"
                            >
                              {saving ? "…" : t("common.confirm")}
                            </button>
                            <button
                              type="button"
                              onClick={() => void deleteSegment(segment)}
                              disabled={busy}
                              title={t("settings.accounts.linkedFund.historyDelete")}
                              aria-label={t("settings.accounts.linkedFund.historyDelete")}
                              className="shrink-0 rounded p-0.5 text-rose-500 transition hover:bg-rose-50 hover:text-rose-600 disabled:cursor-not-allowed disabled:text-slate-300"
                            >
                              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {/* 空行：填上计息日 + 6 位代码就能新增一段（退出日期留空 = 一直生效）。 */}
                  <tr className="bg-slate-50/60">
                    <td className={TD_CLS}>
                      <input
                        type="date"
                        value={newDraft.startDate}
                        max={todayYmd}
                        onChange={(event) => setNewDraft((previous) => ({ ...previous, startDate: event.target.value }))}
                        className={CELL_INPUT_CLS}
                        aria-label={t("settings.accounts.linkedFund.colStartDate")}
                      />
                    </td>
                    <td className={TD_CLS}>
                      <input
                        type="date"
                        value={newDraft.endDate}
                        min={newDraft.startDate || undefined}
                        max={todayYmd}
                        onChange={(event) => setNewDraft((previous) => ({ ...previous, endDate: event.target.value }))}
                        className={CELL_INPUT_CLS}
                        aria-label={t("settings.accounts.linkedFund.colEndDate")}
                      />
                    </td>
                    <td className={TD_CLS}>
                      <input
                        value={newDraft.fundCode}
                        onChange={(event) => {
                          const code = event.target.value.replace(/[^\d]/g, "").slice(0, 6);
                          setNewDraft((previous) => ({ ...previous, fundCode: code }));
                          if (code.length === 6) void resolveFundName(code);
                        }}
                        placeholder={t("settings.accounts.linkedFund.fundCodePlaceholder")}
                        inputMode="numeric"
                        maxLength={6}
                        list="mmh-money-fund-code-suggestions"
                        className={CELL_INPUT_CLS}
                        aria-label={t("settings.accounts.linkedFund.colFundCode")}
                      />
                    </td>
                    <td className={TD_CLS}>
                      <span className="truncate text-[11px] text-slate-400">
                        {newDraft.fundCode.length === 6
                          ? (displayFundName(newDraft.fundCode)
                            || (lookupPending[newDraft.fundCode.trim()]
                              ? t("settings.accounts.linkedFund.fundNameLookup")
                              : t("settings.accounts.linkedFund.fundNameNotFound")))
                          : t("settings.accounts.linkedFund.historyNewRow")}
                      </span>
                    </td>
                    <td className={`${TD_CLS} text-right`}>
                      <button
                        type="button"
                        onClick={createSegment}
                        disabled={busy || !newDraft.startDate || newDraft.fundCode.length !== 6}
                        className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-blue-600 transition hover:bg-blue-50 disabled:cursor-not-allowed disabled:text-slate-300"
                      >
                        {savingId === NEW_ROW_KEY ? "…" : t("common.confirm")}
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="text-[11px] leading-snug text-slate-500">
              {t("settings.accounts.linkedFund.fundCodeHint")}
            </div>
            <div className="text-[11px] leading-snug text-slate-500">
              {t("settings.accounts.linkedFund.noAutoAccrualHint")}
            </div>
          </div>

          {/* 余额宝那几只常用货基给个输入建议，代码始终由用户决定（可能不在名单里）。 */}
          <datalist id="mmh-money-fund-code-suggestions">
            {ALIPAY_BALANCE_BAO_FUNDS.map((fund) => (
              <option key={fund.code} value={fund.code}>{`${fund.name} · ${fund.company}`}</option>
            ))}
          </datalist>

          {segments.length > 0 && (
            <div className="grid gap-1">
              <div className="flex items-end gap-2">
                <label className="grid min-w-0 flex-1 gap-1">
                  <span className={FIELD_LABEL_CLS}>{t("settings.accounts.linkedFund.recalcFromLabel")}</span>
                  <input
                    type="date"
                    value={recalcFrom}
                    max={todayYmd}
                    onChange={(event) => {
                      recalcTouchedRef.current = true;
                      setRecalcFrom(event.target.value);
                    }}
                    className={FIELD_INPUT_CLS}
                  />
                </label>
                <span className="pb-2 text-xs text-slate-400">~</span>
                <label className="grid min-w-0 flex-1 gap-1">
                  <span className={FIELD_LABEL_CLS}>{t("settings.accounts.linkedFund.recalcToLabel")}</span>
                  <input
                    type="date"
                    value={recalcTo}
                    max={todayYmd}
                    onChange={(event) => {
                      recalcTouchedRef.current = true;
                      setRecalcTo(event.target.value);
                    }}
                    className={FIELD_INPUT_CLS}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => void recalc()}
                  disabled={busy}
                  className="inline-flex h-[var(--field-h)] shrink-0 items-center rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
                >
                  {busy ? t("settings.accounts.linkedFund.recalcBusy") : t("settings.accounts.linkedFund.recalc")}
                </button>
              </div>
              <div className="text-[11px] text-slate-400">{t("settings.accounts.linkedFund.recalcHint")}</div>
            </div>
          )}

          {(message || error) && (
            <div className={`text-[11px] ${error ? "text-rose-600" : "text-emerald-600"}`}>{error || message}</div>
          )}
        </div>

      </div>
    </ModalLayer>
  );
}
