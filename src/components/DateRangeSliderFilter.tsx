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
 * 选中块（蓝块）**不是纯比例**：块宽先按时间比例算，再夹一个像素下限
 * （`MIN_BLOCK_PX`），窄区间向中点两侧撑开、靠边时贴边。按比例画时，五年跨度
 * 的轴上选三天只有 1px 宽，鼠标没有落点，两端手柄也叠成一个点，看起来像坏了。
 * 块的几何（`measureBlock`）同时供渲染和指针命中使用，所以「看着多宽」就等于
 * 「能按住多宽」；拖动一律按指针位移换算，撑宽后的手柄不会一按就把区间弹走。
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

/**
 * 选中块的最小像素宽度。
 *
 * 浮块是「整块平移」的唯一抓手，而块宽只按时间比例算时，五年的轴上选三天
 * 只有 1px 宽 —— 指针根本落不进去，两端手柄也叠成一个点，看起来像坏了。
 * 所以块宽先按比例算、再夹一个像素下限（不按天数夹，否则不同跨度的轴上手感
 * 差别巨大），位置以真实区间的中点为心，靠边时贴边。命中判定与渲染共用
 * `measureBlock`，块看着有多宽就能按多宽。
 */
const MIN_BLOCK_PX = 44;

/** 手柄的抓取半径（像素）：块被撑宽后手柄落在块的两端，半径保持不变。 */
const HANDLE_HIT_SLOP = 9;

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

/**
 * 选中块在轨道里的像素几何：`left + width`（相对轨道左端）。
 *
 * 渲染和指针命中都用这一份结果 —— 分开算就会出现「块看着 44px、实际只有
 * 1px 能按」的错位。轨道宽度还没测出来（首帧）时返回 null，调用方退回按
 * 百分比画。
 */
function measureBlock(
  trackWidth: number,
  fromIdx: number,
  toIdx: number,
  minIdx: number,
  span: number,
): { left: number; width: number } | null {
  if (!Number.isFinite(trackWidth) || trackWidth <= 0 || span <= 0) return null;
  const fromPx = ((fromIdx - minIdx) / span) * trackWidth;
  const toPx = ((toIdx - minIdx) / span) * trackWidth;
  const width = Math.min(trackWidth, Math.max(MIN_BLOCK_PX, toPx - fromPx));
  // 中心不动：窄区间向两侧对称撑开，比只往右边长更接近用户的心理位置。
  const left = clamp((fromPx + toPx - width) / 2, 0, Math.max(0, trackWidth - width));
  return { left, width };
}

type DateRangeSliderFilterProps = {
  from: string;
  to: string;
  /** 时间轴左端（数据里最早的一天）。 */
  min: string;
  /**
   * 默认上界：到今天为止的最晚一天。
   *
   * `to` 为空就是「到这个上界为止」——界面上显示的也是它，而不是可拖范围的最右端。
   */
  max: string;
  /**
   * 今天之后还有记账时的最晚一天：滑轨右端会伸到这里。
   *
   * 只有用户主动把截止日拖进这一段（`to` > `max`），明细才会列出未来记账；
   * 未来记账不改变余额、也不进统计，所以默认必须停在 `max`。
   */
  futureMax?: string;
  onChange: (next: { from: string; to: string }) => void;
  /**
   * 弹层刚要打开：调用方可以借此刷新时间轴两端。
   *
   * 刚记了一笔未来流水时，边界还是旧的 —— 不刷新的话滑轨右端不会多出未来那一段，
   * 用户拖到头也看不到那笔账。
   */
  onOpen?: () => void;
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
  futureMax,
  onChange,
  onOpen,
  boundsLoading = false,
  className = "",
}: DateRangeSliderFilterProps) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<"from" | "to" | "move" | null>(null);
  const draftRef = useRef({ fromIdx: 0, toIdx: 0 });
  /**
   * 拖动的起点：按下时的指针位置与当时的区间。
   *
   * 平移和改大小都按「位移」换算而不是「指针下的日期」—— 块被撑到最小宽度
   * 之后，手柄离真实日期本身就有距离，用绝对位置会一按就把区间拽走一大段。
   */
  const dragStartRef = useRef<{ clientX: number; fromIdx: number; toIdx: number } | null>(null);
  const [open, setOpen] = useState(false);
  /** 轨道像素宽度：决定选中块按比例画多宽、以及最小宽度的夹取。 */
  const [trackWidth, setTrackWidth] = useState(0);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({ visibility: "hidden" });
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);
  /** 编辑中的原文：不回写成夹取后的值，避免打断原生日期框的分段编辑。 */
  const [fromInput, setFromInput] = useState<string | null>(null);
  const [toInput, setToInput] = useState<string | null>(null);

  const minIdx = dayIndexOf(min);
  /** 默认上界：`to` 为空时的数据截止日（今天为止的最晚一天）。 */
  const maxIdx = dayIndexOf(max);
  /** 今天之后还有记账时的最晚一天；没有就与默认上界同一个值。 */
  const futureMaxIdx = dayIndexOf(futureMax ?? "");
  /** 滑轨右端：可拖范围伸到未来最晚一天，但「不限制」仍然只到 `max`。 */
  const axisMaxIdx = maxIdx != null && futureMaxIdx != null && futureMaxIdx > maxIdx
    ? futureMaxIdx
    : maxIdx;
  const hasTrack = minIdx != null && axisMaxIdx != null && axisMaxIdx > minIdx;
  const span = hasTrack ? (axisMaxIdx as number) - (minIdx as number) : 0;
  const hasFutureZone = hasTrack && maxIdx != null && axisMaxIdx != null && axisMaxIdx > maxIdx;

  /**
   * `to` 的归一化：停在**默认上界**（今天为止的最后一天）等价于「不限制」，留空。
   * 更左是显式收窄，更右（伸进未来那一段）是显式要看到未来记账。
   *
   * 必须用 `===` 而不是 `>=`：`>=` 会把拖到最右端的未来日期也归一成空值，
   * 于是服务端按「到今天为止」取数，未来记账永远显示不出来。
   */
  const toValueOf = useCallback(
    (index: number) => (maxIdx != null && index === maxIdx ? "" : ymdOfDayIndex(index)),
    [maxIdx],
  );

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
  // 位置一律夹到两端，否则浮块会被画到轨道外面去。`to` 为空表示「到默认上界为止」，
  // 也就是 `max`（今天），不是可拖范围的最右端 —— 未来那一段必须显式拖过去。
  const draftFromIdx = useMemo(() => {
    const parsed = dayIndexOf(draftFrom);
    return clamp(parsed ?? (minIdx as number), minIdx as number, axisMaxIdx as number);
  }, [axisMaxIdx, draftFrom, minIdx]);
  const draftToIdx = useMemo(() => {
    const parsed = dayIndexOf(draftTo);
    return clamp(parsed ?? (maxIdx as number), minIdx as number, axisMaxIdx as number);
  }, [axisMaxIdx, draftTo, maxIdx, minIdx]);

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
   * 量轨道宽度：选中块的像素下限要靠它才能算出来（比例和像素之间只能换算，
   * 不能只靠 CSS 的 `min-width` —— 那样块的实际位置就和命中判定分家了）。
   * 弹层会跟着窗口缩放，所以用 ResizeObserver 而不是只量一次。
   */
  useLayoutEffect(() => {
    if (!open) return;
    const track = trackRef.current;
    if (!track) return;
    const measure = () => setTrackWidth(track.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    return () => observer.disconnect();
    // 弹层宽度由上一支 effect 定（首帧是 `visibility: hidden` 的自适应宽度）：
    // 宽度落定后必须重量一次，否则浮块会先按错误的轨道宽度画一帧。
  }, [hasTrack, open, popoverStyle.width]);

  /**
   * 把草稿的下标区间翻译成对外的 `from/to` 并下发。
   *
   * 顶到时间轴两端等价于「不限制」，直接留空，避免把 2016-01-01 这种边界值
   * 写进筛选后、后来补录了更早的流水却筛不到。
   *
   * 右端有例外：滑轨为了容纳未来记账会伸到 `futureMax`，但「不限制」的口径是
   * **到今天为止**（`max`）。所以只有正好停在 `max` 才是空值，再往右就是显式的
   * 未来截止日 —— 那正是「主动调大显示范围才能看到未来记账」的开关。
   */
  const emitRange = useCallback((fromIdx: number, toIdx: number) => {
    onChange({
      from: minIdx != null && fromIdx <= minIdx ? "" : ymdOfDayIndex(fromIdx),
      to: toValueOf(toIdx),
    });
  }, [minIdx, onChange, toValueOf]);

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
    const nextTo = clamp(index, current.fromIdx, axisMaxIdx as number);
    draftRef.current = { fromIdx: current.fromIdx, toIdx: nextTo };
    setDraftTo(toValueOf(nextTo));
    return draftRef.current;
  }, [axisMaxIdx, minIdx, toValueOf]);

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
    const current = draftRef.current;
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return;
    const block = measureBlock(rect.width, current.fromIdx, current.toIdx, minIdx as number, span);
    if (!block) return;
    const pointerPx = event.clientX - rect.left;
    const blockRight = block.left + block.width;
    // 三档，判定的边界就是块的像素边界（含最小宽度）：靠近块两端 → 改大小；
    // 落在块内 → 整块平移（区间再窄也撑到了可抓宽度，这段永远存在）；
    // 其余空白轨道 → 就近抓一根手柄（不必精确点在把手上）。
    let handle: "from" | "to" | "move";
    /** 落在空白轨道上：这一下是「落点」，直接把就近的手柄挪到指针所在的那天。 */
    let snapToPointer = false;
    if (pointerPx >= block.left - HANDLE_HIT_SLOP && pointerPx <= block.left + HANDLE_HIT_SLOP) {
      handle = "from";
    } else if (pointerPx >= blockRight - HANDLE_HIT_SLOP && pointerPx <= blockRight + HANDLE_HIT_SLOP) {
      handle = "to";
    } else if (pointerPx > block.left + HANDLE_HIT_SLOP && pointerPx < blockRight - HANDLE_HIT_SLOP) {
      // 块心一律平移：即使已经全选（跨度等于时间轴）也走这里，夹取后原地不动，
      // 不会因为点了一下中间就把某端手柄拽到别处。
      handle = "move";
    } else {
      const index = indexFromClientX(event.clientX);
      handle = Math.abs(index - current.fromIdx) <= Math.abs(index - current.toIdx) ? "from" : "to";
      snapToPointer = true;
    }
    dragRef.current = handle;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStartRef.current = { clientX: event.clientX, fromIdx: current.fromIdx, toIdx: current.toIdx };
    if (handle === "move") return;
    // 点在块自身的端点上时先不动，等位移说话（见 dragStartRef 的注释）。
    if (snapToPointer) {
      draftRef.current = applyIndex(handle, indexFromClientX(event.clientX));
      dragStartRef.current = { clientX: event.clientX, fromIdx: draftRef.current.fromIdx, toIdx: draftRef.current.toIdx };
    }
  };

  const moveRangeTo = (clientX: number) => {
    const start = dragStartRef.current;
    const track = trackRef.current;
    if (!start || !track || span <= 0) return;
    const width = track.getBoundingClientRect().width;
    if (width <= 0) return;
    const rangeWidth = start.toIdx - start.fromIdx;
    const delta = Math.round(((clientX - start.clientX) / width) * span);
    // 平移保持跨度不变，只在时间轴内滑动，所以夹住左端即可。
    const nextFrom = clamp(start.fromIdx + delta, minIdx as number, (axisMaxIdx as number) - rangeWidth);
    const nextTo = nextFrom + rangeWidth;
    draftRef.current = { fromIdx: nextFrom, toIdx: nextTo };
    setDraftFrom(nextFrom <= (minIdx as number) ? "" : ymdOfDayIndex(nextFrom));
    setDraftTo(toValueOf(nextTo));
  };

  /** 改大小：同样按指针位移换算，块被撑宽时不会出现「一按就跳一大段」。 */
  const resizeRangeTo = (handle: "from" | "to", clientX: number) => {
    const start = dragStartRef.current;
    const track = trackRef.current;
    if (!start || !track || span <= 0) return;
    const width = track.getBoundingClientRect().width;
    if (width <= 0) return;
    const delta = Math.round(((clientX - start.clientX) / width) * span);
    const base = handle === "from" ? start.fromIdx : start.toIdx;
    draftRef.current = applyIndex(handle, base + delta);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const handle = dragRef.current;
    if (!handle) return;
    event.preventDefault();
    if (handle === "move") {
      moveRangeTo(event.clientX);
      return;
    }
    resizeRangeTo(handle, event.clientX);
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const handle = dragRef.current;
    if (!handle) return;
    dragRef.current = null;
    if (handle === "move") {
      moveRangeTo(event.clientX);
    } else {
      resizeRangeTo(handle, event.clientX);
    }
    dragStartRef.current = null;
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
      setDraftTo(toValueOf(end));
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
    const nextFrom = clamp(Math.round(center - half), minIdx as number, axisMaxIdx as number);
    const nextTo = clamp(Math.round(center + half), nextFrom + 1, axisMaxIdx as number);
    setDraftFrom(nextFrom <= (minIdx as number) ? "" : ymdOfDayIndex(nextFrom));
    setDraftTo(toValueOf(nextTo));
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
  /** 「到今天为止」在轨道上的位置：右边的未来区从这条线开始。 */
  const softMaxPercent = hasTrack && maxIdx != null ? ((maxIdx - (minIdx as number)) / span) * 100 : 100;

  /** 「未来」开关：打开 = 截止日推到未来那段（列出未来记账），关掉 = 回到今天为止。 */
  const futureIncluded = hasTrack && maxIdx != null && draftToIdx > maxIdx;
  const toggleFuture = () => {
    if (!hasTrack || maxIdx == null || axisMaxIdx == null) return;
    const nextToIdx = futureIncluded ? maxIdx : axisMaxIdx;
    // 关掉时截止日被拉回今天，起点若落在它之后要跟着收回，否则区间会反过来。
    const nextFromIdx = Math.min(draftRef.current.fromIdx, nextToIdx);
    draftRef.current = { fromIdx: nextFromIdx, toIdx: nextToIdx };
    setDraftFrom(nextFromIdx <= (minIdx as number) ? "" : ymdOfDayIndex(nextFromIdx));
    setDraftTo(toValueOf(nextToIdx));
  };
  // 浮块和两根手柄都按这份像素几何摆位：块宽有下限，手柄跟着块的两端走，
  // 所以「块看起来有多宽」和「哪里能按住」永远是同一个数。
  // 轨道还没量到时（首帧）退回百分比，layout effect 会在绘制前补上。
  const blockRect = hasTrack ? measureBlock(trackWidth, draftFromIdx, draftToIdx, minIdx as number, span) : null;

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          // 打开时先让调用方刷一次时间轴两端：刚记的未来流水也算进可拖范围。
          if (!open) onOpen?.();
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
                onPointerCancel={() => { dragRef.current = null; dragStartRef.current = null; }}
              >
                <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-slate-200" />
                {/*
                  今天之后的一段单独标出来：它不是「更多历史」，而是「还没发生的账」。
                  颜色深一档 + 一条竖线分隔，提示截止日拖过这条线才会把它们列出来。
                */}
                {hasFutureZone ? (
                  <>
                    <div
                      className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-r-full bg-slate-300"
                      style={{ left: `${softMaxPercent}%`, right: 0 }}
                      title={t("advancedTable.dateRangeFutureHint", { date: max })}
                    />
                    <div
                      className="absolute top-1/2 h-3 w-px -translate-y-1/2 bg-slate-400"
                      style={{ left: `${softMaxPercent}%` }}
                    />
                  </>
                ) : null}
                {/*
                  选中的时间段画成一块可抓的浮块：按住块心整体平移，抓两端手柄改大小。
                  宽度有像素下限（MIN_BLOCK_PX），窄区间向中点两侧撑开 —— 纯按比例画
                  时几年跨度上选几天只有 1px，鼠标根本没地方按。
                */}
                <div
                  className="absolute top-1/2 h-6 -translate-y-1/2 cursor-grab rounded-md border border-blue-400/60 bg-blue-400/25 active:cursor-grabbing"
                  style={blockRect
                    ? { left: blockRect.left, width: blockRect.width }
                    : { left: `${fromPercent}%`, right: `${100 - toPercent}%` }}
                  title={t("advancedTable.dateRangeDragHint")}
                />
                <div
                  role="slider"
                  tabIndex={0}
                  aria-label={t("table.from")}
                  aria-valuemin={minIdx as number}
                  aria-valuemax={axisMaxIdx as number}
                  aria-valuenow={draftFromIdx}
                  aria-valuetext={draftFrom || min}
                  onKeyDown={handleKeyDown("from")}
                  className="absolute top-1/2 h-5 w-2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-[3px] border-2 border-white bg-blue-600 shadow-[0_1px_4px_rgba(15,23,42,0.35)] outline-none focus-visible:ring-2 focus-visible:ring-blue-300"
                  style={{ left: blockRect ? blockRect.left : `${fromPercent}%` }}
                />
                <div
                  role="slider"
                  tabIndex={0}
                  aria-label={t("table.to")}
                  aria-valuemin={minIdx as number}
                  aria-valuemax={axisMaxIdx as number}
                  aria-valuenow={draftToIdx}
                  aria-valuetext={draftTo || max}
                  onKeyDown={handleKeyDown("to")}
                  className="absolute top-1/2 h-5 w-2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-[3px] border-2 border-white bg-blue-600 shadow-[0_1px_4px_rgba(15,23,42,0.35)] outline-none focus-visible:ring-2 focus-visible:ring-blue-300"
                  style={{ left: blockRect ? blockRect.left + blockRect.width : `${toPercent}%` }}
                />
              </div>
              <div className="mt-1 flex items-center justify-between text-xs tabular-nums text-slate-400">
                <span>{min}</span>
                <span>{hasFutureZone ? futureMax : max}</span>
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
              <span className="h-3 w-px shrink-0 bg-slate-200" aria-hidden />
              {/*
                「含未来」开关：未来记账不在默认口径里（不计余额、不进统计），所以
                不放进滑轨的可选区间里让用户猜，而是紧挨着「收窄 / 放宽」的一个显式
                开关 —— 打开就把截止日推到未来那段，关掉就回到今天为止。
                口径说明放在 title 里（悬停才出现），界面上不铺一段常驻文案。
              */}
              <button
                type="button"
                role="switch"
                aria-checked={futureIncluded}
                aria-label={t("advancedTable.dateRangeIncludeFuture")}
                title={t("advancedTable.dateRangeFutureHint", { date: max })}
                onClick={toggleFuture}
                disabled={!hasFutureZone}
                className="inline-flex items-center gap-1.5 rounded-full text-xs text-slate-500 outline-none focus-visible:ring-2 focus-visible:ring-blue-300 disabled:cursor-not-allowed disabled:text-slate-300"
              >
                <span className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${futureIncluded ? "bg-blue-500" : "bg-slate-300"}`}>
                  <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-all ${futureIncluded ? "left-3.5" : "left-0.5"}`} />
                </span>
                <span className={futureIncluded ? "text-blue-600" : ""}>{t("advancedTable.dateRangeIncludeFuture")}</span>
              </button>
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
