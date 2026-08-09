"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type ElementType, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  ArrowRight,
  CheckCircle2,
  Circle,
  CreditCard,
  Database,
  HeartPulse,
  Home,
  Landmark,
  Loader2,
  ReceiptText,
  Shield,
  Users,
  WalletCards,
  X,
} from "lucide-react";
import { InitModal } from "@/components/InitModal";
import {
  FINANCE_DATA_CHANGED_EVENT,
  LEGACY_FINANCE_REFRESH_EVENT,
} from "@/lib/client/refresh";
import { FIRST_USE_GUIDE_OPEN_EVENT } from "@/lib/client/onboardingGuide";

type OnboardingStatus = {
  householdId: string;
  householdName: string;
  defaultOwnerName: string | null;
  familyMemberCount: number;
  accountCount: number;
  cashLikeAccountCount: number;
  cashAccountCount: number;
  debitAccountCount: number;
  creditAccountCount: number;
  investmentAccountCount: number;
  insuranceAccountCount: number;
  settlementAccountCount: number;
  initializationEntryCount: number;
  transactionCount: number;
  fundHoldingCount: number;
  regularInvestPlanCount: number;
  shouldShowGuide: boolean;
};

type StepItem = {
  key: string;
  title: string;
  eyebrow: string;
  detail: string;
  done: boolean;
  optional?: boolean;
  icon: ElementType;
  actionLabel: string;
  action: { type: "initialData" } | { type: "route"; href: string };
  guide: {
    intro: string;
    why: string[];
    actions: string[];
    doneWhen: string[];
    tips?: string[];
  };
};

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function dismissedKey(householdId: string) {
  return `mmh:first-use-guide:dismissed:${householdId}`;
}

function routeMatches(pathname: string | null, href: string) {
  const target = href.split("?")[0] || "/";
  if (!pathname) return false;
  if (target === "/") return pathname === "/";
  return pathname === target || pathname.startsWith(`${target}/`);
}

function StepGuidePanel({
  step,
  onAction,
  routeContentOpen,
  routeReady,
  routePending,
}: {
  step: StepItem;
  onAction: (step: StepItem) => void;
  routeContentOpen: boolean;
  routeReady: boolean;
  routePending: boolean;
}) {
  const ActiveIcon = step.icon;
  const isRouteStep = step.action.type === "route";
  const actionLabel = isRouteStep && routeContentOpen
    ? routeReady
      ? "查看下方页面"
      : "正在打开"
    : step.actionLabel;

  return (
    <section className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 shadow-sm md:px-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${step.done ? "bg-emerald-50 text-emerald-600" : "bg-blue-50 text-blue-600"}`}>
          <ActiveIcon size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-slate-900">{step.title}</span>
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">{step.eyebrow}</span>
            {step.optional ? <span className="rounded bg-white px-1.5 py-0.5 text-[10px] font-medium text-slate-500">可选</span> : null}
            {step.done ? (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600"><CheckCircle2 size={14} />已就绪</span>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-400"><Circle size={14} />待处理</span>
            )}
          </div>
          <div className="mt-1 truncate text-xs text-slate-500" title={step.guide.intro}>{step.guide.intro}</div>
        </div>
        <button
          type="button"
          onClick={() => onAction(step)}
          disabled={isRouteStep && routePending && !routeReady}
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-blue-600 px-3 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-wait disabled:bg-blue-400"
        >
          {isRouteStep && routePending && !routeReady ? <Loader2 size={14} className="animate-spin" /> : null}
          {actionLabel}
          {isRouteStep && routePending && !routeReady ? null : <ArrowRight size={14} />}
        </button>
      </div>

      {step.guide.tips?.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {step.guide.tips.slice(0, 3).map((tip) => (
            <span key={tip} className="rounded bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">
              {tip}
            </span>
            ))}
        </div>
      ) : null}
    </section>
  );
}

function RouteContentPlaceholder({ step }: { step: StepItem }) {
  return (
    <div className="flex min-h-[260px] items-center justify-center rounded-lg border border-dashed border-slate-200 bg-white px-6 py-10 text-center shadow-sm">
      <div>
        <Loader2 className="mx-auto h-6 w-6 animate-spin text-blue-500" />
        <div className="mt-3 text-sm font-medium text-slate-800">正在打开：{step.title}</div>
        <div className="mt-1 text-xs leading-5 text-slate-500">向导说明已切换，目标页面加载完成后会显示在这里。</div>
      </div>
    </div>
  );
}

export function FirstUseGuide({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const guideRef = useRef<HTMLElement>(null);
  const manualOpenRef = useRef(false);
  const prefetchedRoutesRef = useRef(new Set<string>());
  const [routePending, startRouteTransition] = useTransition();
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(true);
  const [mounted, setMounted] = useState(false);
  const [initOpen, setInitOpen] = useState(false);
  const [activeKey, setActiveKey] = useState("ledger");
  const [routeContentOpen, setRouteContentOpen] = useState(false);

  const scrollGuideIntoView = useCallback(() => {
    window.requestAnimationFrame(() => {
      guideRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/onboarding/status", { cache: "no-store" });
      const data = await res.json() as { ok?: boolean; data?: OnboardingStatus };
      if (!data.ok || !data.data) return;
      setStatus(data.data);
      const dismissedToday = localStorage.getItem(dismissedKey(data.data.householdId)) === todayKey();
      const shouldShow = manualOpenRef.current || (data.data.shouldShowGuide && !dismissedToday);
      setVisible(shouldShow);
      if (shouldShow && manualOpenRef.current) scrollGuideIntoView();
    } catch {
      // Non-fatal: onboarding should never block the ledger workspace.
    } finally {
      setLoading(false);
    }
  }, [scrollGuideIntoView]);

  const openGuide = useCallback(() => {
    manualOpenRef.current = true;
    setVisible(true);
    setRouteContentOpen(false);
    void loadStatus();
    scrollGuideIntoView();
  }, [loadStatus, scrollGuideIntoView]);

  useEffect(() => {
    setMounted(true);
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    const refresh = () => { void loadStatus(); };
    const open = () => openGuide();
    window.addEventListener(FINANCE_DATA_CHANGED_EVENT, refresh);
    window.addEventListener(LEGACY_FINANCE_REFRESH_EVENT, refresh);
    window.addEventListener(FIRST_USE_GUIDE_OPEN_EVENT, open);
    return () => {
      window.removeEventListener(FINANCE_DATA_CHANGED_EVENT, refresh);
      window.removeEventListener(LEGACY_FINANCE_REFRESH_EVENT, refresh);
      window.removeEventListener(FIRST_USE_GUIDE_OPEN_EVENT, open);
    };
  }, [loadStatus, openGuide]);

  const prefetchStep = useCallback((step: StepItem) => {
    if (step.action.type !== "route") return;
    const href = step.action.href;
    if (prefetchedRoutesRef.current.has(href)) return;
    prefetchedRoutesRef.current.add(href);
    router.prefetch(href);
  }, [router]);

  const openRouteStep = useCallback((step: StepItem) => {
    if (step.action.type !== "route") return;
    const href = step.action.href;
    setRouteContentOpen(true);
    prefetchStep(step);
    startRouteTransition(() => {
      router.push(href);
    });
  }, [prefetchStep, router, startRouteTransition]);

  const handleStepAction = useCallback((step: StepItem) => {
    if (step.action.type === "initialData") {
      setRouteContentOpen(false);
      setInitOpen(true);
      return;
    }
    openRouteStep(step);
  }, [openRouteStep]);

  const selectStep = useCallback((step: StepItem) => {
    setActiveKey(step.key);
    if (step.action.type === "route") {
      openRouteStep(step);
      return;
    }
    setRouteContentOpen(false);
  }, [openRouteStep]);

  const steps = useMemo<StepItem[]>(() => {
    const current = status ?? {
      householdId: "",
      householdName: "",
      defaultOwnerName: null,
      familyMemberCount: 0,
      accountCount: 0,
      cashLikeAccountCount: 0,
      cashAccountCount: 0,
      debitAccountCount: 0,
      creditAccountCount: 0,
      investmentAccountCount: 0,
      insuranceAccountCount: 0,
      settlementAccountCount: 0,
      initializationEntryCount: 0,
      transactionCount: 0,
      fundHoldingCount: 0,
      regularInvestPlanCount: 0,
      shouldShowGuide: false,
    };
    const resolvedHouseholdName = current.householdName || "当前账簿";
    const ownerName = current.defaultOwnerName || resolvedHouseholdName;
    const hasBaseAccounts = current.cashAccountCount > 0 && current.debitAccountCount > 0 && current.creditAccountCount > 0;
    const hasInitialData = current.initializationEntryCount > 0 || current.fundHoldingCount > 0;

    return [
      {
        key: "ledger",
        title: "账簿名",
        eyebrow: "第 1 步",
        detail: resolvedHouseholdName,
        done: true,
        icon: Home,
        actionLabel: "账簿设置",
        action: { type: "route", href: "/settings/ledgers" },
        guide: {
          intro: `先确认你正在维护的是“${resolvedHouseholdName}”这个账簿。后续成员、账户、初始余额、流水、备份和邀请码都会归到这套账簿下。`,
          why: [
            "账簿是数据隔离边界，不同家庭、个人账套和测试账套不应该混在一起。",
            "切换账簿、数据备份、恢复、邀请码建账都会依赖账簿身份。",
            "账簿名清楚后，家庭成员就不需要继续用账簿名代替真实姓名。",
          ],
          actions: [
            "检查账簿名是否能一眼区分这套数据，例如家庭账、个人账或测试账。",
            "如果这是正式账簿，避免继续使用“默认”“测试”这类临时名称。",
            "需要多人使用时，先确认账簿，再去用户和家庭成员里补人。",
          ],
          doneWhen: [
            `当前账簿显示为：${resolvedHouseholdName}。`,
            "你确认后续初始化数据都应该写入这套账簿。",
            "以后切换账簿时，不会把它和其他账簿混淆。",
          ],
          tips: [
            "账簿不是登录用户名。",
            "账簿也不是家庭成员姓名。",
            "建错账簿时先切换，别继续录初始数据。",
          ],
        },
      },
      {
        key: "family",
        title: "家庭成员",
        eyebrow: "第 2 步",
        detail: `默认成员：${ownerName}`,
        done: current.familyMemberCount > 0,
        icon: Users,
        actionLabel: "维护成员",
        action: { type: "route", href: "/settings/family-members" },
        guide: {
          intro: `家庭成员决定账户、保险、资产和支出的归属。现在默认成员是“${ownerName}”，如果它只是账簿名，建议先改成真实成员名。`,
          why: [
            "银行卡、信用卡、保险、投资账户都需要知道属于谁。",
            "家庭视角下，后续统计可以按成员查看收支、资产和负债。",
            "如果默认成员沿用账簿名，账簿名和用户/成员会混在一起，后续选择会变得不清楚。",
          ],
          actions: [
            `把默认成员“${ownerName}”改成真实姓名或稳定简称。`,
            "为经常发生收支、持有账户或拥有保单的人新增成员。",
            "暂时不需要的成员不要先建，避免账户归属列表变长。",
          ],
          doneWhen: [
            `至少有 1 个真实家庭成员；当前数量：${current.familyMemberCount}。`,
            "主要账户持有人已经能在成员列表里选到。",
            "成员名不是账簿名，也不是登录用户名的占位值。",
          ],
          tips: [
            "成员用于业务归属。",
            "用户用于登录和权限。",
            "账簿用于隔离整套数据。",
          ],
        },
      },
      {
        key: "base-accounts",
        title: "资金账户",
        eyebrow: "第 3 步",
        detail: hasBaseAccounts
          ? `已建立 ${ownerName} 的现金账户、借记卡、信用卡`
          : "补齐现金账户、借记卡、信用卡",
        done: hasBaseAccounts,
        icon: WalletCards,
        actionLabel: "录入初始余额",
        action: { type: "initialData" },
        guide: {
          intro: "资金账户是余额计算的起点。系统应该从账户余额和有序流水推导余额，而不是用收入减支出临时拼出一个数字。",
          why: [
            "现金、借记卡、信用卡是日常流水最常用的落点。",
            "信用卡有账单、还款和溢缴，方向和普通资产账户不同，必须单独建清楚。",
            "录入期初余额后，后续每笔流水才会接在真实余额之后。",
          ],
          actions: [
            `现金账户：${current.cashAccountCount > 0 ? "已建立" : "先补一个常用现金账户"}。`,
            `借记卡：${current.debitAccountCount > 0 ? "已建立" : "补银行卡/储蓄卡账户，并写清机构和尾号"}。`,
            `信用卡：${current.creditAccountCount > 0 ? "已建立" : "补信用卡账户，建议写机构、尾号、账单日和还款日"}。`,
          ],
          doneWhen: [
            "至少有一个现金账户、一个借记卡账户、一个信用卡账户。",
            "常用账户已经设置所有人、机构和可识别名称。",
            "正式记账前的期初余额已经录入，不需要靠第一笔流水倒推余额。",
          ],
          tips: [
            "账户尾号比完整卡号更适合展示。",
            "信用卡还款应该记为账户间转账。",
            "不常用账户可以之后再补。",
          ],
        },
      },
      {
        key: "investment",
        title: "投资账户",
        eyebrow: "第 4 步",
        detail: current.investmentAccountCount > 0
          ? `已有 ${current.investmentAccountCount} 个投资账户，${current.fundHoldingCount} 只基金持仓`
          : "建立基金、理财、贵金属等投资账户",
        done: current.investmentAccountCount > 0 && hasInitialData,
        icon: Database,
        actionLabel: "录入持仓",
        action: { type: "initialData" },
        guide: {
          intro: "投资账户用于把基金、理财、贵金属等持仓放到正确账户下。基金以代码作为计算身份，名称只负责展示。",
          why: [
            "投资资产不能只看买入流水，还要有份额、成本、净值和持仓状态。",
            "期初持仓录清楚后，收益、历史盈亏和后续申购赎回才能连续计算。",
            "账户和产品分开后，同一基金在不同平台的持仓也能区分。",
          ],
          actions: [
            current.investmentAccountCount > 0 ? "检查投资账户名称是否能区分平台或产品类型。" : "先建立一个基金、理财或贵金属投资账户。",
            current.fundHoldingCount > 0 ? "核对已有基金持仓的份额、成本和确认日期。" : "在初始数据窗口录入基金代码、份额、成本和期初净值。",
            "如果有定投，先把账户和基金身份建好，再维护定投计划。",
          ],
          doneWhen: [
            `投资账户数量：${current.investmentAccountCount}；基金持仓数量：${current.fundHoldingCount}。`,
            "主要持仓能按基金代码、账户、份额和成本追溯。",
            "后续新增申购、赎回或定投时，不需要重新猜历史成本。",
          ],
          tips: [
            "基金代码是计算主键。",
            "基金名称不是去重依据。",
            "没有投资资产时可以先跳过。",
          ],
        },
      },
      {
        key: "insurance",
        title: "保险账户",
        eyebrow: "第 5 步",
        detail: current.insuranceAccountCount > 0 ? `已有 ${current.insuranceAccountCount} 个保险账户` : "添加保单与保险资产",
        done: current.insuranceAccountCount > 0,
        optional: true,
        icon: Shield,
        actionLabel: "进入保险",
        action: { type: "route", href: "/insurance" },
        guide: {
          intro: "保险账户用于记录保单、缴费、现金价值和保障对象。它和普通银行卡不同，重点是保单归属和长期现金流。",
          why: [
            "保单通常跨很多年，缴费、续费、退保和现金价值需要独立跟踪。",
            "保险属于具体成员，和家庭总资产、负债和保障情况相关。",
            "把保险放进独立模块，日常消费列表会更清爽。",
          ],
          actions: [
            "有保单时，先添加保险账户或保单产品，再补所属成员。",
            "录入保费、缴费频率、现金价值等后续需要查看的字段。",
            "没有保单或暂时不想维护时，可以保留为未完成但不影响日常记账。",
          ],
          doneWhen: [
            `保险账户数量：${current.insuranceAccountCount}。`,
            "主要保单已经能对应到成员和产品。",
            "下一次保费或回款发生时，知道应该记到哪个保险账户。",
          ],
          tips: [
            "这是可选步骤。",
            "保障信息和现金价值最好分清。",
            "先录主保单，附加险可之后补。",
          ],
        },
      },
      {
        key: "settlements",
        title: "往来款",
        eyebrow: "第 6 步",
        detail: current.settlementAccountCount > 0 ? `已有 ${current.settlementAccountCount} 个往来款账户` : "添加借入、借出、代付对象",
        done: current.settlementAccountCount > 0,
        optional: true,
        icon: Landmark,
        actionLabel: "进入往来款",
        action: { type: "route", href: "/liabilities?guide=settlements" },
        guide: {
          intro: "往来款用于记录借入、借出、代付和待结算。新手阶段先建立往来人员/组织，再在这个对象下面记录第一笔往来款。",
          why: [
            "亲友借款、公司垫付、代买代付都需要保留对手方和余额。",
            "往来款如果记成普通收入/支出，后续很难看清是否已经结清。",
            "把对手方建清楚后，收回、还款和冲销能保持同一条关系。",
          ],
          actions: [
            "先在左侧往来人员列表新增或选中一个对象。",
            "对象存在后，再点击新建往来款，选择借入、借出、还款或收回。",
            "没有往来对象时，可以直接在向导界面或弹窗下拉里新增。",
          ],
          doneWhen: [
            `往来款账户数量：${current.settlementAccountCount}。`,
            "每个未结清对象都能看到应收或应付余额。",
            "后续发生还款/收回时，可以选到同一个对象继续记录。",
          ],
          tips: [
            "这是可选步骤。",
            "不要把借款本金当收入。",
            "不要把收回借款当普通收入。",
          ],
        },
      },
      {
        key: "daily",
        title: "日常记账",
        eyebrow: "最后",
        detail: current.transactionCount > 0 ? `已有 ${current.transactionCount} 条日常流水` : "开始记录收支、转账和业务流水",
        done: current.transactionCount > 0,
        icon: ReceiptText,
        actionLabel: "进入工作区",
        action: { type: "route", href: "/" },
        guide: {
          intro: "日常记账是初始化完成后的主流程。先把账户和期初数据定好，再开始录收支、转账、账单导入和定期计划。",
          why: [
            "日常流水会影响账户余额、分类统计、信用卡账单和资产变化。",
            "如果账户起点不清楚，后续每一笔流水都会变成修余额的补丁。",
            "账单导入和 AI 识别需要依赖已有账户、机构、分类和历史备注来自动判断。",
          ],
          actions: [
            "从最近一笔真实交易开始录入，优先保证账户、方向和分类正确。",
            "信用卡还款、账户互转、充值提现应优先识别为转账。",
            current.regularInvestPlanCount > 0 ? `已有 ${current.regularInvestPlanCount} 个计划任务，可继续核对执行账户。` : "定投、保费、房租和固定扣款可以之后在计划任务里维护。",
          ],
          doneWhen: [
            `日常流水数量：${current.transactionCount}。`,
            "第一批流水保存后，账户余额和统计没有明显方向错误。",
            "常见备注会逐渐沉淀为识别规则，之后导入会更省事。",
          ],
          tips: [
            "先保证方向，再细化分类。",
            "同备注退款可跟随原支出分类。",
            "批量导入后要重点看流入/流出列。",
          ],
        },
      },
    ];
  }, [status]);

  useEffect(() => {
    if (!status) return;
    const firstOpen = steps.find((step) => !step.done && !step.optional) ?? steps[0];
    setActiveKey((current) => steps.some((step) => step.key === current) ? current : firstOpen.key);
  }, [status, steps]);

  useEffect(() => {
    if (!visible) return;
    const timer = window.setTimeout(() => {
      steps.forEach(prefetchStep);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [prefetchStep, steps, visible]);

  if (!mounted || loading || !visible || !status) return <>{children}</>;

  const currentStatus = status;
  const requiredSteps = steps.filter((step) => !step.optional);
  const completedRequired = requiredSteps.filter((step) => step.done).length;
  const activeStep = steps.find((step) => step.key === activeKey) ?? steps[0];
  const activeRouteReady = activeStep.action.type !== "route" || routeMatches(pathname, activeStep.action.href);
  const routeStillLoading = routeContentOpen && activeStep.action.type === "route" && !activeRouteReady;

  function dismissToday() {
    manualOpenRef.current = false;
    localStorage.setItem(dismissedKey(currentStatus.householdId), todayKey());
    setVisible(false);
    setRouteContentOpen(false);
  }

  return (
    <section ref={guideRef} className="flex min-h-0 flex-1 flex-col overflow-hidden bg-slate-50">
      <div className="shrink-0 border-b border-slate-200 bg-white px-3 py-3 shadow-sm md:px-5">
        <div className="mx-auto flex w-full max-w-[1280px] items-start gap-4">
          <div className="w-28 shrink-0 pt-0.5">
            <div className="text-sm font-semibold text-slate-900">首次使用向导</div>
            <div className="mt-1 text-xs leading-5 text-slate-500">
              {currentStatus.householdName ? `${currentStatus.householdName} · ` : ""}{completedRequired}/{requiredSteps.length}
            </div>
          </div>
          <div className="min-w-0 flex-1 overflow-x-auto pb-1">
            <div className="flex min-w-max items-start">
              {steps.map((step, index) => {
                const StepIcon = step.icon;
                const active = step.key === activeStep.key;
                const complete = step.done;
                return (
                  <div key={step.key} className="flex items-start">
                    <button
                      type="button"
                      onClick={() => selectStep(step)}
                      onMouseEnter={() => prefetchStep(step)}
                      onFocus={() => prefetchStep(step)}
                      title={`${step.title}：${step.detail}`}
                      className="group grid w-28 justify-items-center gap-1.5 text-center"
                    >
                      <span
                        className={`flex h-9 w-9 items-center justify-center rounded-full border transition-colors ${
                          active
                            ? "border-blue-600 bg-blue-600 text-white"
                            : complete
                              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                              : "border-slate-200 bg-white text-slate-400 group-hover:border-blue-200 group-hover:text-blue-600"
                        }`}
                      >
                        <StepIcon size={17} />
                      </span>
                      <span className={`text-xs font-medium ${active ? "text-blue-700" : "text-slate-600"}`}>{step.title}</span>
                      <span className="text-[10px] text-slate-400">{step.eyebrow}</span>
                    </button>
                    {index < steps.length - 1 ? (
                      <div className={`mt-[18px] h-0.5 w-10 rounded-full ${complete ? "bg-emerald-200" : "bg-slate-200"}`} />
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
          <button
            type="button"
            onClick={dismissToday}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
            title="今天不再提示"
            aria-label="今天不再提示"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 md:px-5">
        {routeContentOpen && activeStep.action.type === "route" ? (
          <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-3">
            <StepGuidePanel
              step={activeStep}
              onAction={handleStepAction}
              routeContentOpen={routeContentOpen}
              routeReady={activeRouteReady}
              routePending={routePending || routeStillLoading}
            />
            {activeRouteReady ? (
              <div className="min-h-0">
                {children}
              </div>
            ) : (
              <RouteContentPlaceholder step={activeStep} />
            )}
          </div>
        ) : (
        <div className="mx-auto grid w-full max-w-[1280px] gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
          <StepGuidePanel
            step={activeStep}
            onAction={handleStepAction}
            routeContentOpen={routeContentOpen}
            routeReady={activeRouteReady}
            routePending={routePending || routeStillLoading}
          />

          <aside className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <div className="text-sm font-semibold text-slate-700">自动建立的资金起点</div>
            <div className="mt-3 grid gap-2">
              {[
                { label: "现金账户", count: currentStatus.cashAccountCount, icon: WalletCards },
                { label: "借记卡", count: currentStatus.debitAccountCount, icon: Landmark },
                { label: "信用卡", count: currentStatus.creditAccountCount, icon: CreditCard },
                { label: "投资账户", count: currentStatus.investmentAccountCount, icon: HeartPulse },
              ].map((item) => {
                const ItemIcon = item.icon;
                return (
                  <div key={item.label} className="flex items-center justify-between gap-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2 text-sm text-slate-700">
                      <ItemIcon size={16} className="shrink-0 text-slate-400" />
                      <span className="truncate">{item.label}</span>
                    </div>
                    <span className={`shrink-0 text-xs font-medium ${item.count > 0 ? "text-emerald-600" : "text-slate-400"}`}>
                      {item.count > 0 ? `${item.count} 个` : "待建"}
                    </span>
                  </div>
                );
              })}
            </div>
          </aside>
        </div>
        )}
      </div>
      <InitModal open={initOpen} onOpenChange={setInitOpen} />
    </section>
  );
}
