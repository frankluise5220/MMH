"use client";

import { Children, useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";

const STORAGE_KEY = "mmh:reports:summary-height";
const DEFAULT_HEIGHT = 440;
const MIN_PANE_HEIGHT = 104;

function heightBounds(availableHeight: number) {
  const boundedHeight = Math.max(MIN_PANE_HEIGHT, availableHeight);
  const minHeight = Math.min(MIN_PANE_HEIGHT, boundedHeight);
  const maxHeight = Math.max(minHeight, boundedHeight - MIN_PANE_HEIGHT);
  return { minHeight, maxHeight };
}

function clampHeight(value: number, availableHeight: number) {
  const { minHeight, maxHeight } = heightBounds(availableHeight);
  return Math.min(maxHeight, Math.max(minHeight, Math.round(value)));
}

export function ReportResizableSplit({
  hasDetails,
  children,
}: {
  hasDetails: boolean;
  children: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [upperHeight, setUpperHeight] = useState(DEFAULT_HEIGHT);
  const [minimumUpperHeight, setMinimumUpperHeight] = useState(MIN_PANE_HEIGHT);
  const sections = Children.toArray(children);
  const upper = sections[0] ?? null;
  const lower = sections[1] ?? null;

  useEffect(() => {
    const stored = Number(window.localStorage.getItem(STORAGE_KEY));
    const container = containerRef.current;
    if (!container) return;

    function applyBounds(availableHeight: number) {
      setMinimumUpperHeight(heightBounds(availableHeight).minHeight);
      setUpperHeight((current) => clampHeight(current, availableHeight));
    }

    const initialHeight = container.clientHeight;
    setMinimumUpperHeight(heightBounds(initialHeight).minHeight);
    setUpperHeight(clampHeight(Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_HEIGHT, initialHeight));

    const resizeObserver = new ResizeObserver((entries) => {
      applyBounds(entries[0]?.contentRect.height ?? container.clientHeight);
    });
    resizeObserver.observe(container);
    return () => {
      resizeObserver.disconnect();
      document.body.style.userSelect = "";
    };
  }, []);

  function updateHeight(clientY: number) {
    const container = containerRef.current;
    if (!container) return;
    const containerTop = container.getBoundingClientRect().top;
    setUpperHeight(clampHeight(clientY - containerTop, container.clientHeight));
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.style.userSelect = "none";

    const handlePointerMove = (moveEvent: globalThis.PointerEvent) => updateHeight(moveEvent.clientY);
    const finishResize = (upEvent: globalThis.PointerEvent) => {
      updateHeight(upEvent.clientY);
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
      const container = containerRef.current;
      if (!container) return;
      const containerTop = container.getBoundingClientRect().top;
      const nextHeight = clampHeight(upEvent.clientY - containerTop, container.clientHeight);
      window.localStorage.setItem(STORAGE_KEY, String(nextHeight));
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", finishResize, { once: true });
    window.addEventListener("pointercancel", finishResize, { once: true });
  }

  function adjustByKeyboard(delta: number) {
    const availableHeight = containerRef.current?.clientHeight ?? MIN_PANE_HEIGHT;
    setUpperHeight((current) => {
      const next = clampHeight(current + delta, availableHeight);
      window.localStorage.setItem(STORAGE_KEY, String(next));
      return next;
    });
  }

  return (
    <div ref={containerRef} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div
        className="min-h-0 shrink-0 overflow-hidden"
        style={{ height: hasDetails ? upperHeight : "100%" }}
      >
        {upper}
      </div>
      {hasDetails && lower ? (
        <>
          <div
            role="separator"
            aria-label="调整统计表高度"
            aria-orientation="horizontal"
            aria-valuemin={minimumUpperHeight}
            aria-valuenow={upperHeight}
            tabIndex={0}
            onPointerDown={handlePointerDown}
            onKeyDown={(event) => {
              if (event.key === "ArrowUp") {
                event.preventDefault();
                adjustByKeyboard(-24);
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                adjustByKeyboard(24);
              }
            }}
            className="group flex h-4 shrink-0 cursor-row-resize touch-none items-center justify-center outline-none"
            title="拖动调整统计表高度"
          >
            <span className="h-1 w-16 rounded-full bg-slate-300 transition group-hover:bg-blue-400 group-focus:bg-blue-500" />
          </div>
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{lower}</div>
        </>
      ) : null}
    </div>
  );
}
