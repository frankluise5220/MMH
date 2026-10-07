"use client";

import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";

/** 会话内记住每个弹窗（按 key）出现过的最大自然高度，避免同一次会话里反复「长高一次」。 */
const heightCache = new Map<string, number>();

/**
 * 固定弹窗高度：把一个弹窗**锁定到它自己内容出现过的最大自然高度**，
 * 于是切换标签页 / 交易动作时，窗体尺寸与位置都不变：
 *   · 内容短的页签 → 底部留白；
 *   · 内容长的页签 → 在弹窗内滚动（不会把弹窗撑高、也不会整体位移）；
 *   · 保存按钮（若已做成卡片底部的固定页脚）位置恒定。
 *
 * 为什么不用手填高度：每个弹窗内容高度不同、还随语言/字体/数据变化，手填常量必然有的太高、
 * 有的太矮（太矮就出滚动条）。这里改成**运行时量一次**，不需要任何魔数。
 *
 * 用法（四步）：
 *   const { panelRef, scrollRef, fixedHeightProps } = useModalHeightLock("deposit", open);
 *   <div className={`app-modal-panel max-w-xl ${fixedHeightProps.className ?? ""}`}
 *        style={fixedHeightProps.style} ref={panelRef}>
 *     <form className="flex min-h-0 flex-1 flex-col">
 *       <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto ...">…字段…</div>
 *       <div className="shrink-0 border-t ...">…按钮…</div>
 *     </form>
 *   </div>
 *
 * 原理：锁定后仍能算出「当前内容的自然高度」= 面板高 − 滚动区可视高 + 滚动区内容高（与是否锁定无关），
 * 与历史最大值取大即为新的锁定高度，因此不需要先解除锁定再量（不会闪一下）。
 * 面板尚未锁定时本身是 `h-auto`，此时量到的就是自然高度，所以第一次进入即为精确值。
 * 每次渲染后都会复测（开销只有一次布局读取），所以依赖数据异步到位（如存单/持仓加载完）也会自动跟上。
 *
 * 高度通过 `--app-modal-fixed-height` 变量交给 `.app-modal-panel-fixed-height`（见 globals.css）：
 * 移动端（≤767px）那条层外的 `.app-modal-panel { height: 100dvh }` 依旧生效，仍整屏显示。
 *
 * @param key 弹窗标识（同一弹窗多次打开共用缓存，建议写弹窗名，如 "deposit"）
 * @param active 弹窗是否打开（关闭时不测量）
 */
export function useModalHeightLock<
  P extends HTMLElement = HTMLDivElement,
  S extends HTMLElement = HTMLDivElement,
>(key: string, active: boolean) {
  const panelRef = useRef<P | null>(null);
  const scrollRef = useRef<S | null>(null);
  const [height, setHeight] = useState<number | null>(() => {
    const cached = heightCache.get(key);
    return cached && cached > 0 ? cached : null;
  });

  useLayoutEffect(() => {
    if (!active) return;
    const panel = panelRef.current;
    const scroller = scrollRef.current;
    if (!panel || !scroller) return;
    const panelHeight = panel.getBoundingClientRect().height;
    const viewportHeight = scroller.getBoundingClientRect().height;
    if (panelHeight <= 0 || viewportHeight <= 0) return;
    const needed = Math.round(panelHeight - viewportHeight + scroller.scrollHeight);
    if (needed <= 0) return;
    const next = Math.max(needed, heightCache.get(key) ?? 0);
    heightCache.set(key, next);
    setHeight((prev) => (prev != null && prev >= next ? prev : next));
  });

  const locked = height != null && height > 0;
  return {
    panelRef,
    scrollRef,
    /** 展开到弹窗面板上：`className` 只在已量到高度后才给出，未量到时面板保持 `h-auto`（移动端整屏不受影响）。 */
    fixedHeightProps: (locked
      ? {
          className: "app-modal-panel-fixed-height",
          style: { "--app-modal-fixed-height": `${height}px` } as CSSProperties,
        }
      : {}) as { className?: string; style?: CSSProperties },
  };
}
