"use client";

import type { ReactNode, Ref } from "react";
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
 * **FT 卡片、窗体宽度档位、固定高度（切换页签不位移）、滚动区、固定页脚、遮罩层级**全部由这里统一。
 *
 * 分层（自上而下，越下层越通用）：
 *  1. `EntryModalShell`（本文件）= 整窗：遮罩 + 面板 + 标题栏 + 表单 + 页签 + 内容板 + 页脚 + 高度锁定；
 *  2. `FolderTabsCard` = 「页签条 + FT 卡片 + 滚动区 + 固定页脚」的卡片壳（无遮罩/无标题栏）；
 *  3. `@/app/login/FolderTabs` = 页签几何不变量（`folderTabClass` / `FolderTabRuler` / 凹角 CSS）；
 *  4. `useModalHeightLock` + `.app-modal-panel-fixed-height` = 高度锁定规则；
 *  5. `.ft-card-surface` / `.ft-card-footer` / `REQUIRED_FIELD_CLASS` = 卡片外观与必填红框。
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
export type EntryModalWidth = "sm" | "md" | "lg" | "xl";

/** 窗体宽度档位（统一在这里，避免各弹窗各写一个 max-w）：sm 34rem / md 38rem / lg 42rem / xl 48rem。 */
const WIDTH_CLASS: Record<EntryModalWidth, string> = {
  sm: "max-w-[min(34rem,calc(100vw-1rem))]",
  md: "max-w-[min(38rem,calc(100vw-1rem))]",
  lg: "max-w-[min(42rem,calc(100vw-1rem))]",
  xl: "max-w-[min(48rem,calc(100vw-1rem))]",
};

export function EntryModalShell({
  open,
  heightKey,
  width = "md",
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
  const { panelRef, scrollRef, fixedHeightProps } = useModalHeightLock(heightKey, open);
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
          ref={panelRef}
          className={`app-modal-panel ${WIDTH_CLASS[width]} ${fixedHeightProps.className ?? ""}`.trim()}
          style={fixedHeightProps.style}
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
