"use client";

import type { CSSProperties, ReactNode, Ref } from "react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Lock } from "lucide-react";
import { FolderTabsCard, type FolderTabsCardItem } from "@/components/FolderTabsCard";
import {
  registerOpenLayerZIndex,
  ModalLayerProvider,
  useDerivedLayerZIndex,
} from "@/components/ModalLayer";
import { useEntryModalReconciledReadOnly, useResetEntryModalReconciledReadOnlyOnClose } from "@/lib/client/entryModalLock";
import { useModalHeightLock } from "@/lib/client/useModalHeightLock";
import { useI18n } from "@/lib/i18n";

/**
 * 记账弹窗**整窗外壳**：所有「弹出记账窗口」共用的那一层。
 * 各类弹窗只提供「内容」（标题、页签项、字段、底部按钮），
 * **FT 卡片、窗体宽度档位、高度（跟着内容走）、滚动区、窗口底按钮行、遮罩层级**全部由这里统一。
 *
 * 分层（自上而下，越下层越通用）：
 *  1. `EntryModalShell`（本文件）= 整窗：遮罩 + 面板 + 标题栏 + 表单 + 页签 + 内容板 + 按钮行 + 高度测量；
 *  2. `FolderTabsCard` = 「页签条 + FT 卡片 + 滚动区 + 窗口底按钮行」的卡片壳（无遮罩/无标题栏）；
 *  3. `@/app/login/FolderTabs` = 页签几何不变量（`folderTabClass` / `FolderTabRuler` / 凹角 CSS）；
 *  4. `useModalHeightLock` + `.app-modal-panel-fixed-height` = 高度 = 当前内容高度（保证按钮行
 *     与卡片、与窗口边缘的间距同值，见 `FolderTabsCard` 头注释）；同一个 hook 还给「上方位置
 *     固定」的锚点（`--app-modal-anchor-top` + `.app-modal-panel-anchored`）；
 *  5. `.ft-card-surface` / `.ft-card-footer` / `REQUIRED_FIELD_CLASS` = 卡片外观与必填红框。
 *
 * 按钮行规则：退出窗口只有**一个**入口 —— 标题栏右上角的关闭按钮（`onClose`，
 * 文字默认 `table.close`）。`footer` 只放本窗的主操作（保存 / 创建…），
 * **不要再放「取消」**：下面再摆一个取消，和右上角的关闭是同一个动作，重复。
 *
 * **上方位置规则（硬要求）**：窗口顶边只在**首次打开时**定一次（取当时的居中位置），此后
 * 切换页签、内容异步变长变矮，都**只让底边下移或上收** —— 整窗不再跟着垂直居中上下跳。
 * 实现：`useModalHeightLock` 把首帧居中偏移写进 `--app-modal-anchor-top`，遮罩对带
 * `.app-modal-panel-anchored` 的面板改用 `items-start` + `margin-top`；只有内容长到超出
 * 可视区时顶边才被往上顶（保证底边不越界，超出部分在表单滚动区里滚）。
 *
 * 用法：
 *   <EntryModalShell
 *     open={open} heightKey="bond" width="lg" title={t("bondForm.title.create")} onClose={close}
 *     onSubmit={onSubmit}
 *     tabs={[{ id: "buy", label: t("fund.subtype.buy") }, ...]}
 *     activeTabId={subtype} onTabChange={(id) => setSubtype(id as WealthSubtype)}
 *     rulerLabels={["买入", "赎回", "收息", "核销"]}
 *     footer={<><button type="submit" className="primary-button h-9">保存</button></>}
 *   >
 *     ...字段...
 *   </EntryModalShell>
 */
export type EntryModalWidth = "sm" | "md" | "lg" | "xl" | "2xl" | "3xl";

/** 窗体宽度档位（统一在这里，避免各弹窗各写一个 max-w）：sm 34rem / md 38rem / lg 42rem / xl 48rem / 2xl 56rem / 3xl 80rem。
 *  `2xl` 给「明细表列多」的弹窗（报销单：明细 7 列）用，等于原来的 `max-w-4xl`；
 *  `3xl` 给需要在同一张表里容纳抬头 + 7 列明细的纸表单（报销单新建窗，与编辑/审核窗同宽）。 */
const WIDTH_CLASS: Record<EntryModalWidth, string> = {
  sm: "max-w-[min(34rem,calc(100vw-1rem))]",
  md: "max-w-[min(38rem,calc(100vw-1rem))]",
  lg: "max-w-[min(42rem,calc(100vw-1rem))]",
  xl: "max-w-[min(48rem,calc(100vw-1rem))]",
  "2xl": "max-w-[min(56rem,calc(100vw-1rem))]",
  "3xl": "max-w-[min(80rem,calc(100vw-2rem))]",
};

export function EntryModalShell({
  open,
  heightKey,
  width = "md",
  heightMode = "content",
  panelClassName,
  panelStyle,
  panelRef,
  title,
  subtitle,
  onClose,
  closeLabel,
  closeTitle,
  onSubmit,
  formRef,
  tabs,
  activeTabId,
  onTabChange,
  rulerLabels,
  tone = "paper",
  footer,
  zIndex,
  backdropClassName = "",
  portal = true,
  overlays,
  children,
}: {
  open: boolean;
  /** 高度锁定 + 会话缓存用的标识（同一弹窗多次打开共用），如 "bond" */
  heightKey: string;
  width?: EntryModalWidth;
  /**
   * 高度策略：
   *  - `content`（默认）= 按当前内容量高并锁定；**顶边固定**，切换页签只让底边下移/上收；
   *  - `natural` = 不测量、不锁定：窗口高度 = 当前页签内容的自然高度，底边跟着卡片走
   *    （同样顶边固定；宽度/上限可直接用 `panelStyle` 给）。
   *
   * 两种模式的「上方位置」都由 `useModalHeightLock` 锚定（见文件头「上方位置规则」）。
   */
  heightMode?: "content" | "natural";
  /** 外部读取面板节点（锚点浮层要拿面板矩形定位时用）；与内部高度测量共用同一个 DOM 节点。 */
  panelRef?: Ref<HTMLDivElement>;
  /** 面板附加类名（替代宽度档位时用）。 */
  panelClassName?: string;
  /** 面板内联尺寸；与高度锁定的 style 合并，宽度/上限都能在这里给。 */
  panelStyle?: CSSProperties;
  title: ReactNode;
  /** 标题右侧的次要说明（如产品类型） */
  subtitle?: ReactNode;
  onClose: () => void;
  closeLabel?: ReactNode;
  /** 关闭按钮的 title（关闭按钮只有图标时给无障碍名称） */
  closeTitle?: string;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  /** 表单 ref：调用方需要 `formRef.current.requestSubmit()`（如「保存并继续」）时用 */
  formRef?: Ref<HTMLFormElement>;
  /** FT 页签；不给则是不带页签的单表单（卡片顶边直接贴弹窗顶部预留带） */
  tabs?: readonly FolderTabsCardItem[];
  activeTabId?: string;
  onTabChange?: (id: string) => void;
  rulerLabels?: readonly ReactNode[];
  tone?: "paper" | "white";
  /** 卡片底部固定页脚（保存 / 保存并继续等按钮） */
  footer?: ReactNode;
  /** 显式覆盖层级。**一般不要传**：层级已由父层自动推出（顶层 = 基准层，窗口内 = 父层 + 步长）。 */
  zIndex?: number;
  backdropClassName?: string;
  /** 是否挂到 `document.body`（默认是）；若该弹窗原本就地渲染（靠 `z-[…]` 压层），传 `false` 保持挂载点不变 */
  portal?: boolean;
  /**
   * 由本窗口带出的**兄弟浮层**（`<ModalLayer>` 写的那些）。
   * 必须经这里渲染：它在本窗口的层级声明之内，才能自动比本窗口高一步；
   * 写在组件树的别处（本外壳之外）会拿不到层级，退回基准层。
   */
  overlays?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useI18n();
  // 只有 `content` 模式才测量并锁定高度；`natural` 让面板保持 `h-auto`（底边跟卡片）。
  // 两种模式都会量「上方位置」锚点（顶边只在首次打开时定一次，之后不再上下跳）。
  const { panelRef: innerPanelRef, scrollRef, anchorProps, fixedHeightProps } = useModalHeightLock<
    HTMLDivElement,
    HTMLDivElement
  >(heightKey, open, heightMode === "content");
  // 面板节点同时写进内部测量 ref 与调用方 ref（`ConfirmRuleLockNotice` 这类锚点浮层要用面板矩形定位）。
  const setPanelNode = (node: HTMLDivElement | null) => {
    innerPanelRef.current = node;
    if (!panelRef) return;
    if (typeof panelRef === "function") panelRef(node);
    else (panelRef as { current: HTMLDivElement | null }).current = node;
  };
  // 已「对账」的记录：编辑窗照常打开，但整张表单禁用（可查看、不可改）。
  const reconciledReadOnly = useEntryModalReconciledReadOnly();
  useResetEntryModalReconciledReadOnlyOnClose(open);

  // 本窗口占据「由外层推出的层级」：没有外层（顶层窗口）= 基准层；窗口内 = 外层 + 步长。
  // 外层没声明时，还能认出「已经打开着、且 portal 到 body 的窗口」，一样压在它上面。
  // 窗口内的下一层窗口由 `ModalLayer` 自动从这一层 +步长 推出 —— 调用方不需要声明层级。
  // 层级只在外层变化时重新推导：重渲染不能把自己刚登记的那层算进去（否则越渲染越高）。
  const layerZIndex = useDerivedLayerZIndex(zIndex);
  useEffect(() => (open ? registerOpenLayerZIndex(layerZIndex) : undefined), [open, layerZIndex]);

  if (!open || typeof document === "undefined") return null;

  const layer = (
    <ModalLayerProvider value={layerZIndex}>
      <div className={`app-modal-backdrop ${backdropClassName}`.trim()} style={{ zIndex: layerZIndex }}>
        <div
          ref={setPanelNode}
          className={`app-modal-panel ${WIDTH_CLASS[width]} ${anchorProps.className ?? ""} ${
            heightMode === "content" ? (fixedHeightProps.className ?? "") : ""
          } ${panelClassName ?? ""}`.trim()}
          style={{ ...(anchorProps.style ?? null), ...(heightMode === "content" ? fixedHeightProps.style : null), ...panelStyle }}
        >
          <div className="modal-header shrink-0">
            <div className="text-sm font-semibold text-slate-800">
              {title}
              {subtitle ? <span className="ml-2 text-xs font-normal text-slate-500">{subtitle}</span> : null}
            </div>
            <button type="button" onClick={onClose} title={closeTitle} className="secondary-button h-8 px-2">
              {closeLabel ?? t("table.close")}
            </button>
          </div>

          <form ref={formRef} className="flex min-h-0 flex-1 flex-col" onSubmit={onSubmit}>
            {reconciledReadOnly ? (
              <div className="flex shrink-0 items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs font-medium text-amber-800">
                <Lock className="h-3.5 w-3.5 shrink-0" />
                <span>{t("reconcile.readOnlyNotice")}</span>
              </div>
            ) : null}
            {/* 只读时用 disabled 的 fieldset 一次性禁用全部表单控件；
                `contents` 让这层不参与布局，弹窗版式不受影响。 */}
            <fieldset disabled={reconciledReadOnly} className="contents">
              <FolderTabsCard
                tabs={tabs ?? []}
                activeId={activeTabId ?? ""}
                onChange={(id) => onTabChange?.(id)}
                rulerLabels={rulerLabels ?? (tabs ?? []).map((tab) => tab.label)}
                tone={tone}
                footer={footer}
                bodyRef={scrollRef}
              >
                {children}
              </FolderTabsCard>
            </fieldset>
          </form>
        </div>
      </div>
      {overlays}
    </ModalLayerProvider>
  );

  return portal ? createPortal(layer, document.body) : layer;
}
