"use client";

import type { ReactNode, Ref } from "react";
import { FOLDER_TAB_STRIP, FolderTabRuler, folderTabClass, folderTabNeighbors } from "@/app/login/FolderTabs";

/**
 * FT 卡片（文件卡片式页签 + 内容板 + 固定页脚）——**各处记账弹窗的统一外壳**。
 *
 * 这里集中了「弹窗里用 FT 页签」的全部规则，调用方只写字段，不再各写一遍：
 *   1. 外层 `pt-10`：40px 顶部带给页签用，页签底 41px 与内容板顶 40px 恒接缝 −1px
 *      （几何不变量见 `@/app/login/FolderTabs` 文件头，改样式前必读）；
 *   2. 页签组靠左、**等宽**：靠 `FolderTabRuler` 隐形量尺按最长标签定宽（等宽但只占最长标签的宽度，
 *      不铺满整行）；页签组整宽 = N × 最长标签 + 边距，窄容器下等比例收缩并省略号裁切；
 *   3. 内容板 = `.ft-card-surface`（米色卡片 + 圆角 + 边框 + 阴影，几何与配色见 globals.css），
 *      即「实体卡片」，与弹窗白底区分；
 *   4. 内容滚动区：字段写 `children`，超高时**在卡片内滚动**；
 *   5. `footer`：保存/保存并继续等按钮，**固定在卡片底边**（不吸顶、不浮动、不盖住最后一个字段）。
 *
 * 用法（弹窗里）：
 *   <form className="flex min-h-0 flex-1 flex-col" onSubmit={onSubmit}>
 *     <FolderTabsCard
 *       tabs={positions}                       // [{ id, label }]
 *       activeId={activeTabId}
 *       onChange={selectTab}
 *       rulerLabels={positions.map(p => p.labelText)}
 *       footer={<><button type="submit" ...>保存</button></>}
 *     >
 *       ...字段...
 *     </FolderTabsCard>
 *   </form>
 *
 * 弹窗本体（`.app-modal-panel`）若希望**切换页签时窗体尺寸不变**，再加
 * `app-modal-panel-fixed-height`（高度见 globals.css 的 `--app-modal-fixed-height`）。
 */
export type FolderTabsCardItem = {
  id: string;
  label: ReactNode;
  /** 禁止切换（如存款编辑时子类型被锁定）：页签置灰且点击无效 */
  disabled?: boolean;
};

export function FolderTabsCard({
  tabs,
  activeId,
  onChange,
  rulerLabels,
  footer,
  tone = "paper",
  bodyClassName = "",
  bodyRef,
  children,
}: {
  tabs: readonly FolderTabsCardItem[];
  activeId: string;
  onChange: (id: string) => void;
  /**
   * 隐形量尺用的标签（决定等宽基准）。省略时取 `tabs` 的 `label`；
   * 当 `label` 是带图标的复杂节点、或想让宽度按纯文本算时，用本属性传纯文本。
   */
  rulerLabels?: readonly ReactNode[];
  /** 卡片底部页脚：内容固定贴卡片底边，不随内容滚动 */
  footer?: ReactNode;
  /** 卡片色阶：`paper` = 米色 `#fbfaf7`（默认，页签同色衔接）；`white` = 白底卡片 + 白色页签 */
  tone?: "paper" | "white";
  /** 滚动区（字段区）额外类名 */
  bodyClassName?: string;
  /** 滚动区 ref（供 `useModalHeightLock` 等测量内容高度用） */
  bodyRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  const order = tabs.map((tab) => tab.id);
  const ruler = rulerLabels ?? tabs.map((tab) => tab.label);
  const hasTabs = tabs.length > 0;

  return (
    <div className={`relative flex min-h-0 flex-1 flex-col ${hasTabs ? "pt-10" : ""}`}>
      {hasTabs ? (
        <div className={FOLDER_TAB_STRIP}>
          {/* 页签组不设 `w-full`：宽度 = N × 最长标签 + 边距 → 等宽且靠左。 */}
          <div className="flex h-full items-start gap-1.5">
            {tabs.map((tab, index) => {
              const active = tab.id === activeId;
              const disabled = !!tab.disabled;
              return (
                <button
                  key={tab.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => { if (!disabled) onChange(tab.id); }}
                  className={`${folderTabClass(
                    active,
                    index === tabs.length - 1,
                    "stretch",
                    index === 0,
                    folderTabNeighbors(order, tab.id, activeId),
                  )}${active && tone === "white" ? " ft-tab-fillet-white" : ""}${disabled ? " disabled:cursor-not-allowed disabled:opacity-60" : ""}`}
                >
                  {/* 活动页签不能 overflow-hidden（下缘凹角画在按钮盒外），裁切交给内层 span。 */}
                  <span className="relative block overflow-hidden text-ellipsis whitespace-nowrap">
                    <FolderTabRuler labels={ruler} />
                    {tab.label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className={`ft-card-surface${tone === "white" ? " ft-card-surface-white" : ""}`}>
        <div ref={bodyRef} className={`min-h-0 flex-1 space-y-3 overflow-y-auto p-4 ${bodyClassName}`.trim()}>{children}</div>
        {footer ? <div className="ft-card-footer">{footer}</div> : null}
      </div>
    </div>
  );
}
