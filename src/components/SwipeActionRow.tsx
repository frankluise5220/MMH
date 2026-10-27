"use client";

import { useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

export type SwipeActionTone = "neutral" | "primary" | "danger";

export type SwipeActionItem = {
  key: string;
  label: string;
  icon: ReactNode;
  tone?: SwipeActionTone;
  onAction: () => void;
};

const ACTION_WIDTH = 64;
const AXIS_LOCK_DISTANCE = 6;

const TONE_CLASS: Record<SwipeActionTone, string> = {
  neutral: "bg-slate-500 text-white active:bg-slate-600",
  primary: "bg-blue-600 text-white active:bg-blue-700",
  danger: "bg-rose-600 text-white active:bg-rose-700",
};

type SwipeActionRowProps = {
  /** 从右向左滑出的一组操作，按顺序从右往左排列（数组最后一项最靠右）。 */
  actions: SwipeActionItem[];
  /** 展开状态由父级持有，保证同一列表同时只有一行展开。 */
  swipeOpen: boolean;
  onSwipeOpenChange: (open: boolean) => void;
  /** 未发生滑动、且操作区收起时点击内容的回调。 */
  onContentClick?: () => void;
  className?: string;
  children: ReactNode;
};

/**
 * 移动端列表行：内容不动时是一张普通卡片，向左滑露出右侧操作按钮，向右滑收回。
 * 只在触摸/指针设备上工作（桌面端表格分支不渲染它）。
 */
export function SwipeActionRow({
  actions,
  swipeOpen,
  onSwipeOpenChange,
  onContentClick,
  className = "",
  children,
}: SwipeActionRowProps) {
  const width = actions.length * ACTION_WIDTH;
  const [dragOffset, setDragOffset] = useState<number | null>(null);
  const startX = useRef(0);
  const startY = useRef(0);
  const startOffset = useRef(0);
  const lastOffset = useRef(0);
  const axis = useRef<"none" | "x" | "y">("none");
  const moved = useRef(false);
  const pointerId = useRef<number | null>(null);

  const shownOffset = dragOffset ?? (swipeOpen ? -width : 0);
  const dragging = dragOffset !== null;

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    pointerId.current = event.pointerId;
    startX.current = event.clientX;
    startY.current = event.clientY;
    startOffset.current = shownOffset;
    lastOffset.current = shownOffset;
    axis.current = "none";
    moved.current = false;
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (pointerId.current !== event.pointerId) return;
    const dx = event.clientX - startX.current;
    const dy = event.clientY - startY.current;

    if (axis.current === "none") {
      if (Math.abs(dx) < AXIS_LOCK_DISTANCE && Math.abs(dy) < AXIS_LOCK_DISTANCE) return;
      axis.current = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      if (axis.current === "y") {
        // 交还给浏览器做纵向滚动
        pointerId.current = null;
        return;
      }
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    if (axis.current !== "x") return;

    moved.current = true;
    const next = Math.min(0, Math.max(-width, startOffset.current + dx));
    lastOffset.current = next;
    setDragOffset(next);
  }

  function settle(event: ReactPointerEvent<HTMLDivElement>) {
    if (pointerId.current !== event.pointerId) return;
    pointerId.current = null;
    if (axis.current === "x") {
      onSwipeOpenChange(lastOffset.current < -width / 2);
    }
    axis.current = "none";
    setDragOffset(null);
  }

  function handleClickCapture(event: ReactMouseEvent<HTMLDivElement>) {
    // 滑动结束后浏览器仍会补一次 click，这里吞掉，避免误开编辑弹窗
    if (moved.current) {
      moved.current = false;
      event.stopPropagation();
      event.preventDefault();
      return;
    }
    if (swipeOpen || dragOffset !== null) {
      event.stopPropagation();
      event.preventDefault();
      onSwipeOpenChange(false);
      return;
    }
    if (onContentClick) {
      event.stopPropagation();
      onContentClick();
    }
  }

  return (
    <div className={`relative overflow-hidden rounded-xl shadow-sm ring-1 ring-slate-200 ${className}`}>
      <div className="absolute inset-y-0 right-0 flex" style={{ width }}>
        {actions.map((action) => (
          <button
            key={action.key}
            type="button"
            tabIndex={swipeOpen ? 0 : -1}
            aria-hidden={!swipeOpen}
            onClick={(event) => {
              event.stopPropagation();
              onSwipeOpenChange(false);
              action.onAction();
            }}
            className={`flex flex-col items-center justify-center gap-1 text-[11px] font-medium ${TONE_CLASS[action.tone ?? "neutral"]}`}
            style={{ width: ACTION_WIDTH }}
          >
            {action.icon}
            <span>{action.label}</span>
          </button>
        ))}
      </div>
      <div
        data-swipe-content=""
        className={`relative z-10 touch-pan-y rounded-xl bg-white ${dragging ? "" : "transition-transform duration-200 ease-out"}`}
        style={{ transform: `translate3d(${shownOffset}px, 0, 0)` }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={settle}
        onPointerCancel={settle}
        onClickCapture={handleClickCapture}
      >
        {children}
      </div>
    </div>
  );
}
