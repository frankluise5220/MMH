"use client";

import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";

/**
 * 弹窗高度 = **当前内容的自然高度**（运行时量一次，不要手填魔数）。
 *
 * 核心约束（2026-10-23 用户「窗口组件的统一要求」）：
 *   **内容块与按钮行的间距，必须等于按钮行与窗口边缘的间距。**
 * 两者都取 `FolderTabsCard` 的 `gap-3` / `md:px-3 md:pb-3` = 12px。这条约束反过来决定了
 * 窗口高度不能比内容高：多出来的空白只能塞在两处之一 —— 塞在内容块下面会把按钮推远，
 * 塞在按钮下面会让按钮不贴边，两种都被否掉了。窗口贴着内容，两个间距就自然都等于 12px。
 *
 * 代价（有意为之）：同一窗口里切换页签、或数据异步到位使内容变长/变短时，窗口高度会跟着变。
 * 内容超出视口时由 `.app-modal-panel` 的 `max-h` 截断，滚动条出现在表单滚动区里。
 *
 * **上方位置固定**（2026-10-23 用户要求）：窗口顶边只在首次打开时定一次（取当时居中位置），
 * 之后切换页签 / 内容伸缩**只让底边下移或上收**，整窗不再跟着垂直居中重算。实现是把首帧的
 * 居中偏移记进 `--app-modal-anchor-top`，遮罩改为 `items-start` + 面板 `margin-top`；内容长到
 * 超过可视区时才把顶边往上顶（底边不越界）。
 *
 * 为什么不用手填高度：每个弹窗内容高度不同、还随语言/字体/数据变化，手填常量必然
 * 有的太高、有的太矮（太矮就出滚动条）。这里改成运行时测量，不需要任何魔数。
 *
 * 用法（四步）：
 *   const { panelRef, scrollRef, anchorProps, fixedHeightProps } = useModalHeightLock("deposit", open);
 *   <div className={`app-modal-panel max-w-xl ${anchorProps.className ?? ""} ${fixedHeightProps.className ?? ""}`}
 *        style={{ ...anchorProps.style, ...fixedHeightProps.style }} ref={panelRef}>
 *     <form className="flex min-h-0 flex-1 flex-col">
 *       <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto ...">…字段…</div>
 *       <div className="shrink-0 border-t ...">…按钮…</div>
 *     </form>
 *   </div>
 *
 * 原理：锁定后仍能算出「当前内容的自然高度」= 面板高 − 滚动区可视高 + 滚动区内容高
 * （与是否锁定无关），所以不需要先解除锁定再量（不会闪一下）。面板尚未量到时是 `h-auto`，
 * 此时量到的就是自然高度。每次渲染后都复测（只有一次布局读取），依赖数据异步到位
 * （如存单/持仓加载完）也能跟上。
 *
 * 高度通过 `--app-modal-fixed-height` 变量交给 `.app-modal-panel-fixed-height`（见 globals.css）：
 * 移动端（≤767px）那条层外的 `.app-modal-panel { height: 100dvh }` 依旧生效，仍整屏显示。
 *
 * @param _key 弹窗标识（保留：调用方按弹窗名传入，便于排查；曾用于「记住历史最大高度」的会话缓存，
 *   该策略已废弃 —— 保留最大值会让短页签重新出现「按钮离卡片太远」）
 * @param active 弹窗是否打开（关闭时不测量）
 */
export function useModalHeightLock<
  P extends HTMLElement = HTMLDivElement,
  S extends HTMLElement = HTMLDivElement,
>(_key: string, active: boolean, lockHeight = true) {
  const panelRef = useRef<P | null>(null);
  const scrollRef = useRef<S | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  // 窗口「上方位置」锚点（px，相对遮罩内边距）：**只在首次打开时定一次**，之后切页签 / 内容
  // 变高变矮只让面板底边下移或上收，整窗不再跟着垂直居中重算（否则高矮页签来回切换时，
  // 窗口会在视口里上下跳）。见 `EntryModalShell` 头注释「上方位置固定」。
  const anchorTopRef = useRef<number | null>(null);
  const [anchorTop, setAnchorTop] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (!active) {
      // 关闭即清空锚点：下次打开按当时的视口/内容重新居中定顶边。
      anchorTopRef.current = null;
      setAnchorTop(null);
      return;
    }
    const panel = panelRef.current;
    if (!panel) return;
    const panelHeight = panel.getBoundingClientRect().height;
    if (panelHeight <= 0) return;
    // 顶部锚定（与高度测量共用这一次布局读取）：遮罩是 `items-center` 的 flex 容器，
    // 面板高度一变，居中会把顶边也挪动半个差值。这里把「首帧的居中偏移」记下来，之后
    // 以它为顶边；内容长到超出可视区时再向上顶，保证底边不会跑出视口。
    const parent = panel.parentElement;
    if (parent) {
      const style = getComputedStyle(parent);
      const available =
        parent.clientHeight - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0);
      const centered = Math.max(0, Math.round((available - panelHeight) / 2));
      if (anchorTopRef.current == null) anchorTopRef.current = centered;
      const nextTop = Math.max(0, Math.min(anchorTopRef.current, Math.round(available - panelHeight)));
      setAnchorTop((prev) => (prev === nextTop ? prev : nextTop));
    }
    // `natural` 模式只锚定顶边、不锁高度（窗口高度=当前内容高度，底边跟着卡片走）。
    if (!lockHeight) return;
    const scroller = scrollRef.current;
    if (!scroller) return;
    const viewportHeight = scroller.getBoundingClientRect().height;
    if (viewportHeight <= 0) return;
    const needed = Math.round(panelHeight - viewportHeight + scroller.scrollHeight);
    if (needed <= 0) return;
    // 只在数值真的变了才写 state（同值 setState 会被 React 丢弃，不会造成重渲染循环）。
    // 1px 死区：panelHeight 是「被本 hook 锁定」的高度，`panelHeight - viewportHeight + scrollHeight`
    // 的亚像素取整会得到 needed = panelHeight + 1，写回后下一轮再 +1，形成每帧 +1px 的无限增长
    // （内容刚好填满滚动区时触发，如理财窗「核销」页签，React 报 Maximum update depth exceeded）。
    setHeight((prev) => {
      if (prev == null) return needed;
      if (Math.abs(prev - needed) <= 1) return prev;
      return needed;
    });
  });

  const locked = height != null && height > 0;
  const anchored = anchorTop != null;
  const anchorPx = anchorTop ?? 0;
  return {
    panelRef,
    scrollRef,
    /**
     * 上方位置固定：`app-modal-panel-anchored` + `--app-modal-anchor-top`。
     * 两种 `heightMode` 都生效（`natural` 只要顶边不跳，高度本来就跟内容走）。
     * 未量到锚点时不给（面板仍居中，避免首帧从上沿跳一下）。
     */
    anchorProps: (anchored
      ? {
          className: "app-modal-panel-anchored",
          style: { "--app-modal-anchor-top": `${anchorPx}px` } as CSSProperties,
        }
      : {}) as { className?: string; style?: CSSProperties },
    /**
     * 高度锁到当前内容高度：`app-modal-panel-fixed-height` + `--app-modal-fixed-height`。
     * 只有 `content` 模式（`lockHeight`）才会得到值。
     */
    fixedHeightProps: (locked
      ? {
          className: "app-modal-panel-fixed-height",
          style: { "--app-modal-fixed-height": `${height}px` } as CSSProperties,
        }
      : {}) as { className?: string; style?: CSSProperties },
  };
}
