"use client";

import type { ReactNode, Ref } from "react";
import { FOLDER_TAB_STRIP, FolderTabRuler, folderTabClass, folderTabNeighbors } from "@/app/login/FolderTabs";

/**
 * FT 卡片（文件卡片式页签 + 内容板 + 窗口底按钮行）——**各处记账弹窗的统一外壳**。
 *
 * 这里集中了「弹窗里用 FT 页签」的全部规则，调用方只写字段，不再各写一遍：
 *   1. 页签条是**流内**元素（`FOLDER_TAB_STRIP`，高 = 页签内容，底边 = 卡片上缘），
 *      外层**不给 `pt-10`**、条本身也**没有 `h-10`**：卡片顶边由条的实际高度顶出来，
 *      接缝 −1px 由活动页签的 `-mb-px` 结构保证。不随窗口高度伸缩 —— 任何卡片高度、
 *      任何字号下标签页都到不了卡片上缘以下，不会穿出卡片
 *      （几何不变量见 `@/app/login/FolderTabs` 文件头，改样式前必读）；
 *   2. 页签组靠左、**等宽**：靠 `FolderTabRuler` 隐形量尺按最长标签定宽（等宽但只占最长标签的宽度，
 *      不铺满整行）；页签组整宽 = N × 最长标签 + 边距，窄容器下等比例收缩并省略号裁切；
 *      活动页签额外挂 `ft-card-tab-active`：把 `folderTabClass` 的 6/3 内边距改成 4/5，
 *      标签在页签里垂直居中（详情见 globals.css 该类的注释）；
 *   3. 内容板 = `.ft-card-surface`（米色卡片 + 圆角 + 边框 + 阴影，几何与配色见 globals.css），
 *      即「实体卡片」，与弹窗白底区分；卡片高度**跟着内容走**（最后一个字段下面就是卡片底边），
 *      不拉满窗口；
 *   4. 内容滚动区：字段写 `children`，超高时**在卡片内滚动**（卡片才会被压缩）；
 *      滚动区自带 `p-4` 并挂 `ft-card-pad-body`，是**唯一**给卡片内容留白的地方；
 *   5. **卡片里的表格：上下留 12px、左右不留空，上下各一条 1px 外框线，表头与汇总行同色**
 *      （2026-10-31：「看起来像一张卡片纸上画了个表格」→「表格外框呢」→「试着左右不留空，上下留」
 *      →「如果卡片里有表格，表头就应该与汇总行同色」→「汇总行下也应该有外框，与表头上方外框横线
 *      一致」）。规则不在调用点写 `p-*` / `border` / `bg-*`，都在 globals.css 的 FT 卡片层：
 *      留白 = `.ft-card-surface:has(table)` 的 `padding: 12px 0`（卡片里有 `<table>` 就由卡片
 *      自己留白，页签 ≡ 卡片同色衔接不变）；外框 = 表头上沿 `.advanced-table-header`（`border-top`）
 *      + 下沿：无汇总条时是 `.advanced-table-viewport` 的 `border-bottom`，有汇总条时改画在汇总条
 *      下沿（同色同宽 `#cbd5e1`，表体下沿让出 1px 免得并成 2px），左右不画线、方角，因为表体已经
 *      顶到卡片内边缘，卡片那 1px 边框就是表格的左右外框（再画一条会成 2px 双线）；
 *      表头底色 = `--ft-table-band-bg`（= 汇总行那条浅灰，覆盖掉 `ADVANCED_TABLE_HEAD_SURFACE_CLASS`
 *      的米色），于是「灰带 + 白表体 + 灰带」把表格夹成一条。
 *      所以：**表格类内容不要再包一层 `p-*` / `border`**（会变成 24px 或双线），也不要给表头 /
 *      汇总行单独刷底色（会与另一条带不同色），更不要给卡片加 `overflow-visible` / 负边距把表格
 *      拉回去贴边；
 *   6. `footer`：保存/保存并继续等按钮，在卡片**外面**、贴窗口底边（不是卡片的一部分）。
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
 * 间距规则（窗口组件的统一要求，改之前先读）：
 *   **卡片 ↔ 按钮行** 与 **按钮行 ↔ 窗口边缘** 恒为同一个值（12px = `gap-3` / `md:px-3 md:pb-3`）。
 *   这条约束要求弹窗高度**贴着内容**：窗口若比内容高，多出来的空白只能落在卡片下面（按钮被推远）
 *   或按钮下面（按钮不贴边），两种都不接受。所以调用方不要给弹窗加固定高度，
 *   `useModalHeightLock` 量出来的也是内容高度。
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
  /** 卡片外面的底部按钮行：贴窗口底边，不随卡片内容滚动 */
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
    // 版式：**两层**，外框留白只在最外层给一次。
    //   外层（撑满窗口）= [卡片区] + [按钮行]：`gap-3` 兜住最小间距，`mt-auto` 在内容不足时
    //     把多余空白全部推给两者之间 —— 卡片在最后一个字段（如「备注」）下面收尾，保存按钮
    //     留在窗口底边（2026-10-23 用户反馈「卡片到备注下面就结束，保存按钮在窗口里」）。
    //     报销单三窗的窗口高度改成跟内容走（`heightMode="natural"`）后没有多余空白可推，
    //     按钮行就紧贴卡片右下角（2026-10-23 用户反馈「下面空太多，保存应在右下角」）。
    //   卡片区（默认 `0 1 auto`，不撑满）= 页签条 + 卡片。页签条是**流内**元素
    //     （`FOLDER_TAB_STRIP`，高 = 页签内容，见 `FolderTabs` 文件头第 1、2 条）：卡片顶边
    //     由页签条实际高度顶出来，全链路没有写死的高度数，放大 / 改字号都不会错位；
    //     流内元素天然落在外层 `md:px-3` 的 padding 盒里，页签与卡片左右自然对齐。
    //     （历史：页签条曾是 `absolute`，先后用过 `bottom-0` 铺满层（挂外层时会铺到按钮行底下，
    //     非活动页签跟着拉长露出灰底「假页签」）和 `h-10` 固定 40px 带（不穿出但 40 写死，
    //     放大失灵）——2026-10-25 用户两轮反馈后定为流内内容高。）
    // `md:px-3 md:pb-3`：卡片（页签条、按钮行一并）与窗口边缘留 12px 呼吸空间，否则卡片左右
    //   直接压在 `.app-modal-panel` 的边框上（2026-10-23 用户反馈「FT 卡片与窗口边缘基本重合」）。
    //   外层给了 padding 之后，流内页签条自动落在缩进后的盒子里，不必再单独 `mx-3`。
    //   只从 `md`（768px，= `.app-modal-panel` 退出全屏的断点）起生效：移动端弹窗满屏白底、
    //   卡片本来就该贴边，留白反而多出一圈白边。
    <div className="relative flex min-h-0 flex-1 flex-col gap-3 md:px-3 md:pb-3">
      <div className="relative flex min-h-0 flex-col">
        {hasTabs ? (
          <div className={FOLDER_TAB_STRIP}>
            {/* 页签组不设 `w-full`：宽度 = N × 最长标签 + 边距 → 等宽且靠左。 */}
            <div className="flex items-start gap-1.5">
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
                    )}${active ? " ft-card-tab-active" : ""}${active && tone === "white" ? " ft-tab-fillet-white" : ""}${disabled ? " disabled:cursor-not-allowed disabled:opacity-60" : ""}`}
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
          {/* `ft-card-pad-body`：本层自带 `p-4`，卡片**不要**再加表格留白（globals.css 里
              `.ft-card-surface:has(table)` 会跳过挂了本标记的滚动区，避免 12 + 16 叠成一圈） */}
          <div ref={bodyRef} className={`ft-card-pad-body min-h-0 flex-1 space-y-3 overflow-y-auto p-4 ${bodyClassName}`.trim()}>{children}</div>
        </div>
      </div>

      {/* 按钮行在卡片**外面**（窗口里）：卡片按内容高度结束，按钮贴窗口底边。
          内边距写在这里：移动端弹窗满屏、外层没有左右 padding，需要自己留 16px；
          桌面由外层的 `md:px-3 md:pb-3` 提供，故用 `md:px-0 md:pb-0` 抹平。
          上下留白必须同值：上方只由外层 `gap-3` 给 12px（这里不再加 `pt`，否则上 24 / 下 12
          两边不对称），下方由 `pb-3`（移动端）/ 外层 `md:pb-3`（桌面）给 12px。 */}
      {footer ? <div className="ft-card-footer mt-auto px-4 pb-3 md:px-0 md:pb-0">{footer}</div> : null}
    </div>
  );
}
