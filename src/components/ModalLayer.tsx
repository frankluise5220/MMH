"use client";

import { createContext, useContext, useEffect, useRef, useSyncExternalStore, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** 顶层窗口的基准层级：不在任何窗口内时，第一个窗口从这里起算。 */
const BASE_MODAL_Z_INDEX = 1000;
/** 每嵌套一层窗口，层级递增的步长。 */
const MODAL_LAYER_STEP = 10;

/** 当前所在窗口层的 z-index；0 = 不在任何窗口内（顶层）。 */
const ModalLayerContext = createContext(0);

/**
 * 已经打开着的窗口层（本模块自己开的那些）。
 * 用于「从窗口带出新窗口时自动压在上面」——新窗口不必等父窗口用 Provider 声明自己。
 */
const openLayerZIndexes = new Set<number>();

function isFullViewportOverlay(el: Element) {
  if (typeof window === "undefined") return false;
  const r = el.getBoundingClientRect();
  return r.width >= window.innerWidth - 1 && r.height >= window.innerHeight - 1;
}

/**
 * 「现在最上面那层窗口是多少」：本模块登记过的层 ∪ 已 portal 到 body 的旧窗口。
 * 后者是给**还没迁移**的窗口兜底的：它们只要 portal 到 body 且是整屏遮罩，
 * 从它里面开出的新窗口依然能自动压在它上面。
 */
function peekOpenLayerZIndex(): number {
  let max = 0;
  openLayerZIndexes.forEach((z) => {
    if (z > max) max = z;
  });
  if (typeof document === "undefined" || !document.body) return max;
  for (const el of Array.from(document.body.children)) {
    const cs = getComputedStyle(el);
    if (cs.position !== "fixed") continue;
    const z = Number(cs.zIndex);
    if (!Number.isFinite(z) || z < BASE_MODAL_Z_INDEX) continue;
    if (!isFullViewportOverlay(el)) continue;
    if (z > max) max = z;
  }
  return max;
}

/** 登记「本层已打开」；返回反登记函数（窗口关闭时调用）。 */
export function registerOpenLayerZIndex(z: number): () => void {
  openLayerZIndexes.add(z);
  return () => {
    openLayerZIndexes.delete(z);
  };
}

/**
 * 「我现在在哪一层」：0 = 顶层；其余为所在窗口层的 z-index。
 * 窗口靠它推导自己的层级，**不需要**由调用方声明「我该在哪一层」。
 */
function useModalLayerZIndex() {
  return useContext(ModalLayerContext);
}

/**
 * 推导本窗口的层级：`max(父窗口声明的层, 当前已打开的最上层) + 步长`。
 *
 * **只在「父层变化」时重新采样**：窗口挂载后会反复重渲染（受控输入、高度锁定、只读态等），
 * 若每次重渲染都重新采样，就会把**自己刚登记的那层**也数进去 → 外层 1000 的窗口下一次渲染
 * 变成 1010、再下一次 1020……表现为「同一窗口越用越往上飘」。
 */
export function useDerivedLayerZIndex(explicitZIndex?: number) {
  const parentZIndex = useModalLayerZIndex();
  const ref = useRef<{ parent: number; explicit: number | undefined; z: number } | null>(null);
  if (!ref.current || ref.current.parent !== parentZIndex || ref.current.explicit !== explicitZIndex) {
    const z = explicitZIndex ?? getNextModalLayerZIndex(Math.max(parentZIndex, peekOpenLayerZIndex()));
    ref.current = { parent: parentZIndex, explicit: explicitZIndex, z };
  }
  return ref.current.z;
}

/** 由父层推导子层：顶层 → 基准层；窗口内 → 父层 + 步长。 */
function getNextModalLayerZIndex(parentZIndex: number) {
  return parentZIndex > 0 ? parentZIndex + MODAL_LAYER_STEP : BASE_MODAL_Z_INDEX;
}

/** 向下声明「本层 z-index」，让内层窗口自动比本层高一步。 */
export function ModalLayerProvider({ value, children }: { value: number; children: ReactNode }) {
  return <ModalLayerContext.Provider value={value}>{children}</ModalLayerContext.Provider>;
}

/**
 * 是否已经在客户端。
 *
 * ⚠️ 不能写成 `useState(false)` + `useEffect(() => setState(true))`：那样**每次挂载**的
 * 第一帧都返回 `null`（窗口不存在），第二帧才 portal 出遮罩。用户切页签时窗口是
 * 「卸载一个、挂载另一个」，于是整页会闪一下（遮罩消失一帧、背景页露出来）。
 * `useSyncExternalStore` 的 server snapshot 恒 false（SSR/hydration 不 mismatch），
 * hydration 一结束立刻变 true；之后**新挂载的窗口首帧就是 true**，没有空帧。
 */
const subscribeNever = () => () => {};
function useIsClient() {
  return useSyncExternalStore(subscribeNever, () => true, () => false);
}

/**
 * **窗口原语**：层级由「它所在的那层窗口」自动推出，调用方**不声明层级**。
 *
 * 四个约束写在组件里，而不是留给每个调用点：
 *  1. **必须 portal 到 `document.body`**：窗口常挂在 `.page-header`（`position:sticky` +
 *     `backdrop-filter`）内部，该祖先同时是 fixed 后代的**包含块**与 z-30 **层叠上下文** ——
 *     就地渲染时 `inset-0` 会相对 56px 高的标题条解析（窗口被压扁）、且永远压不过 portal
 *     到 body 的外层遮罩，表现为「新窗口藏在原窗口后面、无法输入」。
 *  2. **必须用 inline style 给 z-index**：`.app-modal-backdrop` 的 `@apply z-[1000]` 在编译
 *     产物里排在 `z-[…]` 工具类之后，同特异性下后者被静默吞掉 —— 类名写的层级不生效。
 *  3. **自动取父层 + 步长**：`max(父窗口声明的层, 当前已打开的最上层) + 步长`
 *     （父窗口未声明时，已 portal 到 body 的旧窗口也能被认出，一样递增）。
 *  4. **登记本层**，让从它里面再开出的窗口自动比自己高一步。
 *
 * 用法（一个数字都不写）：
 *   <ModalLayer>…面板…</ModalLayer>
 */
export function ModalLayer({
  className = "app-modal-backdrop",
  style,
  zIndex,
  children,
  ...rest
}: {
  className?: string;
  style?: CSSProperties;
  /** 显式覆盖层级。**一般不要传**：层级已由父层自动推出（顶层 = 基准层，窗口内 = 父层 + 步长）。 */
  zIndex?: number;
  children?: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, "className" | "style" | "children">) {
  const resolvedZIndex = useDerivedLayerZIndex(zIndex);
  const isClient = useIsClient();

  useEffect(() => registerOpenLayerZIndex(resolvedZIndex), [resolvedZIndex]);

  // 渲染期也要能取到当前栈（父窗口若是上一次提交打开的，Provider 与登记都还没建立）
  if (!isClient) return null;

  return createPortal(
    <ModalLayerContext.Provider value={resolvedZIndex}>
      <div {...rest} className={className} style={{ ...style, zIndex: resolvedZIndex }}>
        {children}
      </div>
    </ModalLayerContext.Provider>,
    document.body,
  );
}
