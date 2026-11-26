"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { FocusEvent as ReactFocusEvent, PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowUpDown, Filter, GripVertical, Info, MoveHorizontal } from "lucide-react";
import { getOverlayLayerZIndex } from "@/components/ModalLayer";

/**
 * 统一提示系统（hint，不是 title）。
 *
 * 全站所有「悬停/聚焦才知道能干什么」的提示都必须走这里，不要在组件里再写
 * `title="..."`（浏览器原生 tooltip 的延迟、配色、位置、消失时机全都不可控，
 * 同一张表头会同时出现原生 tooltip 和自定义药丸两种效果）。
 *
 * 三条契约：
 *   1. 视觉唯一 —— 深色药丸，由 `HintPill` 渲染，调用方只能选图标和文字。
 *   2. 触发唯一 —— 指针停留 `HINT_DELAY_MS`（300ms）后出现，键盘聚焦走同一时长；
 *      指针按下、离开、滚动、窗口变化、Esc、锚点消失都立即收起。
 *   3. 锚点唯一 —— 一个 `key` 对应一个锚点；同一锚点可挂多条（如表格表头同时提示
 *      「可拖拽调整列顺序」和「点击排序 / 双击筛选」），纵向堆叠、整体居中。
 */

/** 指针停留多久才出提示。表头长按拾起列是 400ms，必须早于它，否则列已经被拿起了提示才出来。 */
export const HINT_DELAY_MS = 300;
/**
 * 提示层基准层级：必须压在页面所有常规浮层之上（用户菜单/通知面板 1200、纠错提示条 1300），
 * 否则侧边栏菜单里的提示会被自己的菜单盖住；同时留在计算器与持仓选择器（9999）之下。
 * 窗口（ModalLayer）打开时再与窗口层派生值取大者，保证提示不会被窗口遮罩吃掉。
 */
const HINT_Z_INDEX = 9500;
/** 提示与锚点之间的间距。 */
const HINT_ANCHOR_GAP = 6;
/** 提示与视口边缘的最小距离。 */
const HINT_EDGE_PADDING = 8;
/** 锚点从 DOM 里消失（弹窗关闭、表格重绘）后的兜底检查间隔。 */
const HINT_ANCHOR_WATCH_MS = 400;

export type HintIcon = "drag" | "sort" | "filter" | "resize" | "info";
export type HintPlacement = "bottom" | "top";

export type HintItem = {
  /** 同一锚点内的稳定标识，只用于 React key。 */
  id?: string;
  label: string;
  icon?: HintIcon;
  /** 长文案（单元格全文、错误说明）允许换行；默认超过 26 字自动换行。 */
  wrap?: boolean;
};

export type HintGroupSpec = { key: string; items: HintItem[] };

type HintGroup = {
  key: string;
  anchor: HTMLElement;
  items: HintItem[];
  placement: HintPlacement;
};

const HINT_ICON_COMPONENTS = {
  drag: GripVertical,
  sort: ArrowUpDown,
  filter: Filter,
  resize: MoveHorizontal,
  info: Info,
} as const;

let activeHint: HintGroup | null = null;
const hintSubscribers = new Set<() => void>();

function publishHint(next: HintGroup | null) {
  activeHint = next;
  for (const notify of Array.from(hintSubscribers)) notify();
}

function subscribeHints(notify: () => void) {
  hintSubscribers.add(notify);
  return () => {
    hintSubscribers.delete(notify);
  };
}

function getActiveHint() {
  return activeHint;
}

function getServerHint() {
  return null;
}

/** 收起提示。传 `key` 时只在当前提示属于该锚点时才收，避免两个锚点互相踩。 */
export function hideHints(key?: string) {
  if (!activeHint) return;
  if (key && activeHint.key !== key) return;
  publishHint(null);
}

/**
 * 底层触发器：给「一张表里每一列/每一行都是一个锚点」这类不能在循环里调 hook 的场景用。
 * `enter` 的 `element` 必须是真实 DOM（`event.currentTarget`），提示跟随它的位置。
 */
export function useHintTrigger(options?: { delayMs?: number; placement?: HintPlacement }) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const timerRef = useRef<number | null>(null);
  // 按下之后到离开锚点之前不再弹：点表头排序、点按钮、拉列宽都不该再冒出提示。
  const suppressedRef = useRef(false);

  const cancel = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const enter = useCallback(
    (element: HTMLElement, spec: HintGroupSpec) => {
      if (spec.items.length === 0) return;
      cancel();
      const commit = () => {
        timerRef.current = null;
        if (suppressedRef.current) return;
        if (!element.isConnected || element.getClientRects().length === 0) return;
        publishHint({
          key: spec.key,
          anchor: element,
          items: spec.items,
          placement: optionsRef.current?.placement ?? "bottom",
        });
      };
      const delay = optionsRef.current?.delayMs ?? HINT_DELAY_MS;
      if (delay <= 0) commit();
      else timerRef.current = window.setTimeout(commit, delay);
    },
    [cancel],
  );

  const leave = useCallback(
    (key?: string) => {
      cancel();
      suppressedRef.current = false;
      hideHints(key);
    },
    [cancel],
  );

  const press = useCallback(
    (key?: string) => {
      cancel();
      suppressedRef.current = true;
      hideHints(key);
    },
    [cancel],
  );

  useEffect(() => cancel, [cancel]);

  return useMemo(() => ({ enter, leave, press }), [enter, leave, press]);
}

/**
 * 单锚点提示：把返回值摊到任意元素上即可。
 *
 * ```tsx
 * const hint = useHint("toolbar:filter", [{ label: "筛选", icon: "filter" }]);
 * <button {...hint} aria-label="筛选" />
 * ```
 * 元素自带可见文字时不要再用提示——提示只补充「看不见的能力说明」。
 */
export function useHint(
  key: string,
  items: HintItem[] | null | undefined,
  options?: { delayMs?: number; placement?: HintPlacement; enabled?: boolean },
) {
  const trigger = useHintTrigger(options);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const enabledRef = useRef(options?.enabled !== false);
  enabledRef.current = options?.enabled !== false;

  return useMemo(() => {
    const schedule = (element: HTMLElement) => {
      if (!enabledRef.current) return;
      const list = itemsRef.current;
      if (!list || list.length === 0) return;
      trigger.enter(element, { key, items: list });
    };
    return {
      onPointerEnter: (event: ReactPointerEvent<HTMLElement>) => {
        // 触屏没有 hover 语义，长按另有手势，不在这里弹。
        if (event.pointerType === "touch") return;
        schedule(event.currentTarget);
      },
      onPointerLeave: () => trigger.leave(key),
      onPointerDown: () => trigger.press(key),
      onFocus: (event: ReactFocusEvent<HTMLElement>) => {
        if (event.target !== event.currentTarget) return;
        schedule(event.currentTarget);
      },
      onBlur: () => trigger.leave(key),
    };
  }, [key, trigger]);
}

function HintPill({ item }: { item: HintItem }) {
  const Icon = item.icon ? HINT_ICON_COMPONENTS[item.icon] : null;
  const wrap = item.wrap ?? item.label.length > 26;
  return (
    <span className="mmh-hint-pill flex max-w-full items-center gap-1 rounded-md bg-slate-800/95 px-2 py-1 text-[11px] font-medium leading-4 text-white shadow-[0_8px_20px_rgba(15,23,42,0.22)]">
      {Icon ? <Icon className="h-3 w-3 shrink-0 opacity-80" aria-hidden="true" /> : null}
      <span className={wrap ? "min-w-0 whitespace-normal break-words text-left" : "whitespace-nowrap"}>
        {item.label}
      </span>
    </span>
  );
}

/**
 * 提示宿主：挂在根布局一次。
 *
 * 提示是 fixed 定位的视觉层（`aria-hidden`），不参与命中测试，也不接管焦点——
 * 无障碍信息由触发元素自己的 `aria-label` 提供，不依赖这个浮层。
 */
export function HintLayer() {
  const group = useSyncExternalStore(subscribeHints, getActiveHint, getServerHint);
  const [mounted, setMounted] = useState(false);
  const stackRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number; zIndex: number } | null>(null);

  useEffect(() => setMounted(true), []);

  // 任何位移 / 尺寸变化 / 失焦 / Esc 都立即收起：提示的位置一旦不准，就是错误信息。
  useEffect(() => {
    const hide = () => hideHints();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("blur", hide);
    window.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("visibilitychange", hide);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("blur", hide);
      window.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("visibilitychange", hide);
    };
  }, []);

  // 锚点被卸载（弹窗关闭、表头因筛选重绘）时不会触发 pointerleave，必须兜底收起。
  useEffect(() => {
    if (!group) return;
    const timer = window.setInterval(() => {
      if (!group.anchor.isConnected || group.anchor.getClientRects().length === 0) hideHints(group.key);
    }, HINT_ANCHOR_WATCH_MS);
    return () => window.clearInterval(timer);
  }, [group]);

  useLayoutEffect(() => {
    setPosition(null);
    if (!group) return;
    let cancelled = false;
    const place = () => {
      if (cancelled) return;
      const stack = stackRef.current;
      const anchor = group.anchor;
      if (!stack || !anchor.isConnected) {
        hideHints(group.key);
        return;
      }
      const rect = anchor.getBoundingClientRect();
      const stackRect = stack.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      // 先水平居中于锚点，再整体夹进视口；夹不住（提示比视口还宽）时退回居中。
      const half = stackRect.width / 2;
      const minCenter = HINT_EDGE_PADDING + half;
      const maxCenter = viewportWidth - HINT_EDGE_PADDING - half;
      const preferredCenter = rect.left + rect.width / 2;
      const left = minCenter <= maxCenter
        ? Math.min(Math.max(preferredCenter, minCenter), maxCenter)
        : viewportWidth / 2;
      // 下方放不下就翻到上方；上方也放不下就贴视口上沿，宁可盖住一点也别溢出屏幕。
      const below = rect.bottom + HINT_ANCHOR_GAP;
      const above = rect.top - HINT_ANCHOR_GAP - stackRect.height;
      const top = group.placement === "top"
        ? Math.max(HINT_EDGE_PADDING, above)
        : (below + stackRect.height <= viewportHeight - HINT_EDGE_PADDING
          ? below
          : Math.max(HINT_EDGE_PADDING, above));
      setPosition({ left, top, zIndex: Math.max(HINT_Z_INDEX, getOverlayLayerZIndex(0)) });
    };
    place();
    // 长文案换行后高度会变，下一帧再校一次。
    const frame = window.requestAnimationFrame(place);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [group]);

  if (!mounted || !group) return null;

  return createPortal(
    <div
      ref={stackRef}
      data-mmh-hint={group.key}
      aria-hidden="true"
      className="pointer-events-none fixed flex flex-col items-center gap-1"
      style={{
        left: position?.left ?? -9999,
        top: position?.top ?? -9999,
        zIndex: position?.zIndex ?? HINT_Z_INDEX,
        transform: "translateX(-50%)",
        maxWidth: "min(22rem, calc(100vw - 16px))",
      }}
    >
      {group.items.map((item, index) => (
        <HintPill key={item.id ?? index} item={item} />
      ))}
    </div>,
    document.body,
  );
}
