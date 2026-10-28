"use client";

import { createPortal } from "react-dom";
import {
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { CalendarRange, ChevronDown } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { useOutsideClose } from "@/lib/client/useOutsideClose";
import { DateStepper } from "./DateStepper";

/**
 * 「显示范围」：一枚 chip + 双滑块弹层。
 *
 * 为什么要有：明细表头每一列都挂了一个漏斗按钮，看某一段时间还得点进「日期」列
 * 的漏斗里手输两个日期。把「看哪一段」单独抽成一条带滑块的入口，表头按钮不再
 * 增长，而且「拉宽 / 收窄时间段」是拖动两根手柄，不用反复点输入框。
 *
 * 值的契约：**完全独立**于 ADT 的筛选/排序/分页 —— `from/to` 由调用方受控持有，
 * 组件自己不存范围、也不读表格数据。两端都为空表示「全部时间」。调用方负责把
 * `from~to` 作为独立的数据范围参数（明细视图是 `range`）下推查询。
 *
 * chip 的宽度自适应内容：日期是等宽数字，截断会把截止日的后两位吃掉。
 *
 * 日期一律按 `YYYY-MM-DD` 日历日处理：换算成「UTC 天序号」做滑块刻度，绝不用
 * 本地时区的 Date(y, m, d)，否则东八区凌晨会整体偏一天。
 */

const DAY_MS = 86_400_000;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
// 与表头列筛选弹层（FilterPopover 默认 256）同属一套弹层：太宽会和它并排时
// 明显不是一个体系，太窄滑块又不好拖，取 288。
//
// 五个快捷区间要排成一行，靠的是把文案压到两个字（`30 天` / `90 天` / `今年` /
// `去年` / `全部`）并把按钮左右内边距归零：288 时每格 51px，最长的一条
// （英文 `This year` 47px + 描边 2px）刚好放得下，不需要为了这一行加宽弹层。
const POPOVER_WIDTH = 288;

function dayIndexOf(ymd: string) {
  if (!YMD_RE.test(ymd)) return null;
  const [year, month, day] = ymd.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

function ymdOfDayIndex(index: number) {
  return new Date(index * DAY_MS).toISOString().slice(0, 10);
}

function clamp(value: number, lower: number, upper: number) {
  return Math.min(upper, Math.max(lower, value));
}

/**
 * 只有真实存在的日历日才算数：`2026-02-30` 会被 `Date.UTC` 滚到 3 月 2 日，
 * 那种输入必须挡掉，不能悄悄改成另一天。
 */
function resolveDayIndex(ymd: string) {
  const index = dayIndexOf(ymd);
  if (index == null) return null;
  return ymdOfDayIndex(index) === ymd ? index : null;
}

type DateRangeSliderFilterProps = {
  from: string;
  to: string;
  /** 时间轴左端（数据里最早的一天）。 */
  min: string;
  /** 时间轴右端（数据里最晚的一天）。 */
  max: string;
  onChange: (next: { from: string; to: string }) => void;
  /**
   * 时间轴两端还在取数（服务端全量 min/max 通常比首屏分页慢几秒）。
   *
   * chip 本身照常显示当前范围，只把弹层里的滑块换成「读取中」—— 组件不能因为
   * 时间轴没到就整块消失，否则表格已经画完了它才补出来，看起来像是 ADT 算完
   * 才生成的。
   */
  boundsLoading?: boolean;
  className?: string;
};

export function DateRangeSliderFilter({
  from,
  to,
  min,
  max,
  onChange,
  boundsLoading = false,
  className = "",
}: DateRangeSliderFilterProps) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<"from" | "to" | "move" | null>(null);
  const draftRef = useRef({ fromIdx: 0, toIdx: 0 });
  /** 整块平移的起点：按下时的指针位置与当时的区间，避免逐帧累加误差。 */
  const moveStartRef = useRef<{ clientX: number; fromIdx: number; toIdx: number } | null>(null);
  const [open, setOpen] = useState(false);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({ visibility: "hidden" });
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);
  /** 编辑中的原文：不回写成夹取后的值，避免打断原生日期框的分段编辑。 */
  const [fromInput, setFromInput] = useState<string | null>(null);
  const [toInput, setToInput] = useState<string | null>(null);

  const minIdx = dayIndexOf(min);
  const maxIdx = dayIndexOf(max);
  const hasTrack = minIdx != null && maxIdx != null && maxIdx > minIdx;
  const span = hasTrack ? (maxIdx as number) - (minIdx as number) : 0;

  // 打开时才把外部状态搬进草稿：拖动中的草稿不能跟着外部 props 回写，
  // 否则松手提交 → 父级重取 → props 更新会让手柄跳一下。
  useEffect(() => {
    if (!open) return;
    setDraftFrom(from);
    setDraftTo(to);
    setFromInput(null);
    setToInput(null);
  }, [from, open, to]);

  // 外部筛选可能落在时间轴之外（例如 URL 里写着 2020 年、而本页数据只有最近几天）：
  // 位置一律夹到两端，否则浮块会被画到轨道外面去。
  const draftFromIdx = useMemo(() => {
    const parsed = dayIndexOf(draftFrom);
    return clamp(parsed ?? (minIdx as number), minIdx as number, maxIdx as number);
  }, [draftFrom, maxIdx, minIdx]);
  const draftToIdx = useMemo(() => {
    const parsed = dayIndexOf(draftTo);
    return clamp(parsed ?? (maxIdx as number), minIdx as number, maxIdx as number);
  }, [draftTo, maxIdx, minIdx]);

  useEffect(() => {
    draftRef.current = { fromIdx: draftFromIdx, toIdx: draftToIdx };
  }, [draftFromIdx, draftToIdx]);

  useOutsideClose(rootRef, open, () => setOpen(false));

  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const anchor = rootRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const padding = 8;
      const width = Math.min(POPOVER_WIDTH, window.innerWidth - padding * 2);
      const estimatedHeight = 236;
      const openAbove = rect.bottom + estimatedHeight + padding > window.innerHeight && rect.top > estimatedHeight;
      setPopoverStyle({
        position: "fixed",
        top: openAbove ? Math.max(padding, rect.top - estimatedHeight - 4) : rect.bottom + 4,
        left: Math.min(Math.max(padding, rect.right - width), Math.max(padding, window.innerWidth - width - padding)),
        width,
        zIndex: 30000,
        visibility: "visible",
      });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    document.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      document.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  /**
   * 把草稿的下标区间翻译成对外的 `from/to` 并下发。
   *
   * 顶到时间轴两端等价于「不限制」，直接留空，避免把 2016-01-01 这种边界值
   * 写进筛选后、后来补录了更早的流水却筛不到。
   */
  const emitRange = useCallback((fromIdx: number, toIdx: number) => {
    onChange({
      from: minIdx != null && fromIdx <= minIdx ? "" : ymdOfDayIndex(fromIdx),
      to: maxIdx != null && toIdx >= maxIdx ? "" : ymdOfDayIndex(toIdx),
    });
  }, [maxIdx, minIdx, onChange]);

  /**
   * 「确认」下发草稿 —— 时间轴上的任何改动（拖动、平移、收窄/放宽、快捷区间、
   * 清空）都只落在草稿里，只有点这里才会真的重取表格。
   *
   * 一次范围变化意味着服务端按新范围重新计数、重排逐笔余额，代价远不止一次
   * 分页查询；每拖一下松手就发一次会把服务端打成雪崩，也会让用户还没想好要看
   * 哪一段就先把表刷了三遍。所以「改完 → 看一眼顶部日期 → 确认」是唯一入口。
   */
  const submitDraft = useCallback(() => {
    const { fromIdx, toIdx } = draftRef.current;
    emitRange(fromIdx, toIdx);
  }, [emitRange]);

  const applyIndex = useCallback((handle: "from" | "to", index: number) => {
    const current = draftRef.current;
    if (handle === "from") {
      const nextFrom = clamp(index, minIdx as number, current.toIdx);
      draftRef.current = { fromIdx: nextFrom, toIdx: current.toIdx };
      setDraftFrom(nextFrom <= (minIdx as number) ? "" : ymdOfDayIndex(nextFrom));
      return draftRef.current;
    }
    const nextTo = clamp(index, current.fromIdx, maxIdx as number);
    draftRef.current = { fromIdx: current.fromIdx, toIdx: nextTo };
    setDraftTo(nextTo >= (maxIdx as number) ? "" : ymdOfDayIndex(nextTo));
    return draftRef.current;
  }, [maxIdx, minIdx]);

  const indexFromClientX = useCallback((clientX: number) => {
    const track = trackRef.current;
    if (!track || span <= 0) return (minIdx as number) ?? 0;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return minIdx as number;
    const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
    return Math.round((minIdx as number) + ratio * span);
  }, [minIdx, span]);

  /**
   * 日期框 → 草稿。走和拖动同一条 `applyIndex` 通道（夹到时间轴内、保持
   * from ≤ to、顶到两端归一成「不限制」），所以点日历、按年月日分段改、
   * 拖手柄三种改法产生的 `from/to` 口径一致。
   */
  const applyTypedDate = useCallback((handle: "from" | "to", next: string) => {
    const index = resolveDayIndex(next);
    if (index == null) return;
    applyIndex(handle, index);
  }, [applyIndex]);

  /** 日期框内按 Enter 直接确认，省一次鼠标移动。 */
  const handleTypedKeyDown = useCallback((event: { key: string; preventDefault: () => void }) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    setOpen(false);
    startTransition(() => submitDraft());
  }, [submitDraft]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!hasTrack) return;
    event.preventDefault();
    const index = indexFromClientX(event.clientX);
    const current = draftRef.current;
    const track = trackRef.current;
    const rect = track?.getBoundingClientRect();
    const pointerPx = rect ? event.clientX - rect.left : 0;
    const pxPerDay = rect && span > 0 ? rect.width / span : 0;
    const fromPx = pxPerDay * (current.fromIdx - (minIdx as number));
    const toPx = pxPerDay * (current.toIdx - (minIdx as number));
    const hitSlop = 9;
    // 三档：靠近两端手柄 → 改大小；落在选中块内部 → 整块平移；
    // 其余空白轨道 → 就近抓一根手柄（轨道窄时不必精确点在小圆点上）。
    let handle: "from" | "to" | "move";
    if (pointerPx >= fromPx - hitSlop && pointerPx <= fromPx + hitSlop) {
      handle = "from";
    } else if (pointerPx >= toPx - hitSlop && pointerPx <= toPx + hitSlop) {
      handle = "to";
    } else if (pointerPx > fromPx + hitSlop && pointerPx < toPx - hitSlop) {
      // 块心一律平移：即使已经全选（跨度等于时间轴）也走这里，夹取后原地不动，
      // 不会因为点了一下中间就把某端手柄拽到别处。
      handle = "move";
    } else {
      handle = Math.abs(index - current.fromIdx) <= Math.abs(index - current.toIdx) ? "from" : "to";
    }
    dragRef.current = handle;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (handle === "move") {
      moveStartRef.current = { clientX: event.clientX, fromIdx: current.fromIdx, toIdx: current.toIdx };
      return;
    }
    moveStartRef.current = null;
    draftRef.current = applyIndex(handle, index);
  };

  const moveRangeTo = (clientX: number) => {
    const start = moveStartRef.current;
    const track = trackRef.current;
    if (!start || !track || span <= 0) return;
    const width = track.getBoundingClientRect().width;
    if (width <= 0) return;
    const rangeWidth = start.toIdx - start.fromIdx;
    const delta = Math.round(((clientX - start.clientX) / width) * span);
    // 平移保持跨度不变，只在时间轴内滑动，所以夹住左端即可。
    const nextFrom = clamp(start.fromIdx + delta, minIdx as number, (maxIdx as number) - rangeWidth);
    const nextTo = nextFrom + rangeWidth;
    draftRef.current = { fromIdx: nextFrom, toIdx: nextTo };
    setDraftFrom(nextFrom <= (minIdx as number) ? "" : ymdOfDayIndex(nextFrom));
    setDraftTo(nextTo >= (maxIdx as number) ? "" : ymdOfDayIndex(nextTo));
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    event.preventDefault();
    if (dragRef.current === "move") {
      moveRangeTo(event.clientX);
      return;
    }
    applyIndex(dragRef.current, indexFromClientX(event.clientX));
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const handle = dragRef.current;
    if (!handle) return;
    dragRef.current = null;
    moveStartRef.current = null;
    if (handle === "move") {
      moveRangeTo(event.clientX);
    } else {
      draftRef.current = applyIndex(handle, indexFromClientX(event.clientX));
    }
    // 松手只落草稿；下发在「确认」。
  };

  /**
   * 快捷区间：只改草稿，仍等「确认」才刷新表格。
   *
   * 和拖动同一套节奏 —— 「全部时间」尤其不能偷偷直接下发：用户点它往往只是先
   * 看一眼全量跨度，真正生效应当由确认按钮那一下决定。
   */
  const applyQuickRange = (kind: "all" | "last30" | "last90" | "thisYear" | "lastYear") => {
    if (!hasTrack) return;
    const minValue = minIdx as number;
    const maxValue = maxIdx as number;
    if (kind === "all") {
      draftRef.current = { fromIdx: minValue, toIdx: maxValue };
      setDraftFrom("");
      setDraftTo("");
      return;
    }
    if (kind === "thisYear" || kind === "lastYear") {
      const year = Number(ymdOfDayIndex(maxValue).slice(0, 4)) - (kind === "lastYear" ? 1 : 0);
      const start = clamp(dayIndexOf(`${year}-01-01`) as number, minValue, maxValue);
      const end = clamp(dayIndexOf(`${year}-12-31`) as number, minValue, maxValue);
      draftRef.current = { fromIdx: start, toIdx: end };
      setDraftFrom(start <= minValue ? "" : ymdOfDayIndex(start));
      setDraftTo(end >= maxValue ? "" : ymdOfDayIndex(end));
      return;
    }
    const days = kind === "last30" ? 30 : 90;
    const start = clamp(maxValue - (days - 1), minValue, maxValue);
    draftRef.current = { fromIdx: start, toIdx: maxValue };
    setDraftFrom(start <= minValue ? "" : ymdOfDayIndex(start));
    setDraftTo("");
  };

  /** 以当前区间中点为中心整体收窄 / 放宽，「增加缩小时间段」不用重新拖两端。 */
  const zoomRange = (factor: number) => {
    if (!hasTrack) return;
    const { fromIdx, toIdx } = draftRef.current;
    const center = (fromIdx + toIdx) / 2;
    const half = Math.max(1, ((toIdx - fromIdx) / 2) * factor);
    const nextFrom = clamp(Math.round(center - half), minIdx as number, maxIdx as number);
    const nextTo = clamp(Math.round(center + half), nextFrom + 1, maxIdx as number);
    setDraftFrom(nextFrom <= (minIdx as number) ? "" : ymdOfDayIndex(nextFrom));
    setDraftTo(nextTo >= (maxIdx as number) ? "" : ymdOfDayIndex(nextTo));
    draftRef.current = { fromIdx: nextFrom, toIdx: nextTo };
  };

  const handleKeyDown = (handle: "from" | "to") => (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!hasTrack) return;
    const step = event.shiftKey ? 7 : 1;
    const current = draftRef.current;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = event.key === "ArrowLeft" ? -step : step;
    const target = (handle === "from" ? current.fromIdx : current.toIdx) + delta;
    applyIndex(handle, target);
  };

  const active = !!from || !!to;
  const label = from && to
    ? `${from} ~ ${to}`
    : from
      ? `${from} ~`
      : to
        ? `~ ${to}`
        : t("advancedTable.dateRangeAll");
  const dayCount = hasTrack ? draftToIdx - draftFromIdx + 1 : 0;
  const fromPercent = hasTrack ? ((draftFromIdx - (minIdx as number)) / span) * 100 : 0;
  const toPercent = hasTrack ? ((draftToIdx - (minIdx as number)) / span) * 100 : 100;

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
        // 与工具栏右端的日期定位输入框（DateStepper：h-7 / rounded / text-xs /
        // border-slate-200 / 白底）同一套度量：字体、高度、描边粗细、4px 倒角都对齐，
        // 不再用 secondary-button 的 10px 圆角和淡描边，否则两个并排的日期控件一眼
        // 就是两个体系。
        className={`inline-flex h-7 shrink-0 items-center gap-1 rounded border bg-white px-2 text-xs tabular-nums text-slate-700 transition-colors hover:bg-slate-50 ${active ? "border-blue-300 text-blue-700" : "border-slate-200"}`}
        title={t("advancedTable.dateRangeFilter")}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <CalendarRange className="h-3.5 w-3.5 shrink-0" />
        {/* 日期是等宽数字，截断会把截止日的后两位吃掉：整段完整显示，不设上限。 */}
        <span className="whitespace-nowrap">{label}</span>
        <ChevronDown className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? createPortal(
        <div
          className="rounded-lg border border-slate-200 bg-white p-2 shadow-xl"
          style={popoverStyle}
          // portal 挂在 body 上：不让 mousedown 冒到 document，否则 useOutsideClose 会立刻关掉。
          onMouseDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          role="dialog"
          aria-label={t("advancedTable.dateRangeFilter")}
        >
          <div className="mb-2 flex items-center justify-between gap-2 border-b border-slate-100 pb-2">
            <span className="text-xs font-medium text-slate-700">{t("advancedTable.dateRangeFilter")}</span>
            <div className="flex items-center gap-2">
              {hasTrack ? <span className="text-xs tabular-nums text-slate-500">{t("advancedTable.dateRangeDays", { count: dayCount })}</span> : null}
              <button type="button" onClick={() => setOpen(false)} className="text-xs text-slate-400 hover:text-slate-700">
                {t("table.close")}
              </button>
            </div>
          </div>
          {hasTrack ? (
            <>
              {/*
                起止日期可以直接改：滑块负责「拉宽 / 收窄」，但要精确落到某一天
                （对账单日、报销周期）时，拖到手柄附近再去抠那 1px 没有必要。

                这里用的就是全站同一个日期组件 `DateStepper`：原生日期输入，
                双击年份只改年份、双击月份只改月份，右边还有日历按钮。之前自己
                写过一个「只收数字、自动补 `-`」的文本框，代价是整串一起变 ——
                想只改年份也得把整串重打，反而不如原生分段编辑。

                两处细节：
                1. **不传 min / max**。原生日期框一旦把范围写进 `min`/`max`，
                    逐位输入年份时中间值（`0002`、`0020`）会被判成越界直接拒绝，
                    表现就是「敲了一个数字就跳到月份」；
                2. 编辑中的原文留在 `fromInput/toInput` 里，不立刻用夹取后的值
                    回写 `value`，否则每敲一个数字 React 重写一次 value，分段
                    焦点被重置，只能整串重打。

                改完的值仍然走和拖动同一条 `applyIndex` 通道：夹到时间轴之内、
                保持 from ≤ to、顶到两端归一成「不限制」。失焦时把输入框回写成
                夹取后的值，越界的输入不会留在框里。
              */}
              <div className="mb-1 flex items-center gap-1.5 text-slate-600">
                <div className="min-w-0 flex-1" title={t("table.from")}>
                  <DateStepper
                    compact
                    value={fromInput ?? (draftFrom || min)}
                    onChange={(next) => {
                      setFromInput(next);
                      applyTypedDate("from", next);
                    }}
                    onBlur={() => setFromInput(null)}
                    onKeyDown={handleTypedKeyDown}
                    className="!h-7 !rounded !pl-1.5 !pr-6 !text-xs tabular-nums"
                  />
                </div>
                <span className="shrink-0 text-slate-300">~</span>
                <div className="min-w-0 flex-1" title={t("table.to")}>
                  <DateStepper
                    compact
                    value={toInput ?? (draftTo || max)}
                    onChange={(next) => {
                      setToInput(next);
                      applyTypedDate("to", next);
                    }}
                    onBlur={() => setToInput(null)}
                    onKeyDown={handleTypedKeyDown}
                    className="!h-7 !rounded !pl-1.5 !pr-6 !text-xs tabular-nums"
                  />
                </div>
              </div>
              <div
                ref={trackRef}
                className="relative mt-2 h-8 cursor-pointer touch-none select-none"
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={() => { dragRef.current = null; }}
              >
                <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-slate-200" />
                {/* 选中的时间段画成一块可抓的浮块：按住块心整体平移，抓两端手柄改大小。 */}
                <div
                  className="absolute top-1/2 h-6 -translate-y-1/2 cursor-grab rounded-md border border-blue-400/60 bg-blue-400/25 active:cursor-grabbing"
                  style={{ left: `${fromPercent}%`, right: `${100 - toPercent}%` }}
                  title={t("advancedTable.dateRangeDragHint")}
                />
                <div
                  role="slider"
                  tabIndex={0}
                  aria-label={t("table.from")}
                  aria-valuemin={minIdx as number}
                  aria-valuemax={maxIdx as number}
                  aria-valuenow={draftFromIdx}
                  aria-valuetext={draftFrom || min}
                  onKeyDown={handleKeyDown("from")}
                  className="absolute top-1/2 h-5 w-2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-[3px] border-2 border-white bg-blue-600 shadow-[0_1px_4px_rgba(15,23,42,0.35)] outline-none focus-visible:ring-2 focus-visible:ring-blue-300"
                  style={{ left: `${fromPercent}%` }}
                />
                <div
                  role="slider"
                  tabIndex={0}
                  aria-label={t("table.to")}
                  aria-valuemin={minIdx as number}
                  aria-valuemax={maxIdx as number}
                  aria-valuenow={draftToIdx}
                  aria-valuetext={draftTo || max}
                  onKeyDown={handleKeyDown("to")}
                  className="absolute top-1/2 h-5 w-2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-[3px] border-2 border-white bg-blue-600 shadow-[0_1px_4px_rgba(15,23,42,0.35)] outline-none focus-visible:ring-2 focus-visible:ring-blue-300"
                  style={{ left: `${toPercent}%` }}
                />
              </div>
              <div className="mt-1 flex items-center justify-between text-xs tabular-nums text-slate-400">
                <span>{min}</span>
                <span>{max}</span>
              </div>
            </>
          ) : (
            <p className="py-3 text-center text-xs text-slate-500">
              {boundsLoading ? t("advancedTable.dateRangeLoading") : t("advancedTable.dateRangeEmpty")}
            </p>
          )}
          {/* 五个快捷区间排一行，按跨度从窄到宽：30 天 / 90 天 / 今年 / 去年 / 全部。
              两行会把弹层撑高，而它们只是「一眼就能点」的次要入口。左右内边距归零，
              288px 里五等分每格 51px，最长的一条文案刚好放得下、不折行。 */}
          <div className="mt-2 grid grid-cols-5 gap-1 text-center">
            <button type="button" onClick={() => applyQuickRange("last30")} disabled={!hasTrack} className="whitespace-nowrap rounded border border-slate-200 px-0 py-1 text-[11px] text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300 disabled:hover:bg-white">{t("advancedTable.dateRangeLast30")}</button>
            <button type="button" onClick={() => applyQuickRange("last90")} disabled={!hasTrack} className="whitespace-nowrap rounded border border-slate-200 px-0 py-1 text-[11px] text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300 disabled:hover:bg-white">{t("advancedTable.dateRangeLast90")}</button>
            <button type="button" onClick={() => applyQuickRange("thisYear")} disabled={!hasTrack} className="whitespace-nowrap rounded border border-slate-200 px-0 py-1 text-[11px] text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300 disabled:hover:bg-white">{t("advancedTable.dateRangeThisYear")}</button>
            <button type="button" onClick={() => applyQuickRange("lastYear")} disabled={!hasTrack} className="whitespace-nowrap rounded border border-slate-200 px-0 py-1 text-[11px] text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300 disabled:hover:bg-white">{t("advancedTable.dateRangeLastYear")}</button>
            <button type="button" onClick={() => applyQuickRange("all")} disabled={!hasTrack} className="whitespace-nowrap rounded border border-slate-200 px-0 py-1 text-[11px] text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300 disabled:hover:bg-white">{t("advancedTable.dateRangeAllShort")}</button>
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            {/* 收窄/放宽只是微调，用和「清空」同层的文字按钮，别在同一个弹层里
                再摆一排描边小按钮 —— 那是列表头筛选弹层里没有的视觉层级。 */}
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <button type="button" onClick={() => zoomRange(0.5)} disabled={!hasTrack} className="hover:text-slate-700 disabled:cursor-not-allowed disabled:text-slate-300" title={t("advancedTable.dateRangeNarrow")}>{t("advancedTable.dateRangeNarrow")}</button>
              <button type="button" onClick={() => zoomRange(2)} disabled={!hasTrack} className="hover:text-slate-700 disabled:cursor-not-allowed disabled:text-slate-300" title={t("advancedTable.dateRangeWiden")}>{t("advancedTable.dateRangeWiden")}</button>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  // 「清空」只把草稿复位成整条时间轴；真的清空（重取全量表格）仍然
                  // 由「确认」那一下决定 —— 弹层里所有改动都必须走同一个出口。
                  if (!hasTrack) return;
                  draftRef.current = { fromIdx: minIdx as number, toIdx: maxIdx as number };
                  setDraftFrom("");
                  setDraftTo("");
                }}
                disabled={!hasTrack}
                className="text-xs text-blue-600 hover:text-blue-700 disabled:cursor-not-allowed disabled:text-slate-300"
              >
                {t("table.clear")}
              </button>
              <button
                type="button"
                onClick={() => {
                  // 先关弹层，再把范围提交出去。
                  //
                  // 提交会让持有方按新窗口重算整页（本地裁剪几千行 + 整表重渲染，
                  // 缓存没覆盖时还要等一次取数）。两件事放在同一个高优先级批次里，
                  // 浏览器必须先跑完这轮渲染才能提交 UI —— 用户看到的就是
                  // 「点了确认，面板卡住一下才消失」。关闭走同步 lane，提交走
                  // transition：弹层立刻收起，计算在后台照常完成。
                  setOpen(false);
                  startTransition(() => submitDraft());
                }}
                disabled={!hasTrack}
                className="h-8 shrink-0 rounded border border-blue-200 bg-blue-50 px-3 text-xs text-blue-700 hover:bg-blue-100 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-50 disabled:text-slate-300"
              >
                {t("table.confirm")}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
