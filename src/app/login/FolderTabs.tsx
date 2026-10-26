"use client";

import type { ReactNode } from "react";

/**
 * 文件卡片式页签（folder / file-card tab）。
 *
 * 视觉语义：活动页签压在内容板上、与内容板连成一体；非活动页签是「叠在当前卡片后面」
 * 的一张更高的卡片，只露出顶部标签头，主体被内容板盖住。
 *
 * 从登录页抽出的可复用组件，供「登录方式页签」和「建账方式页签」共用。
 * 核心不变量（改样式前必读，均有几何/像素探针守护）：
 *
 *  1. 页签条是**流内**元素（不是 absolute、不写高度）：高度由页签内容撑开（= 最高页签的外沿高），
 *     内容板紧跟其后。**全链路没有任何写死的高度数**——没有 `pt-10`、没有 `h-10`、没有
 *     `bottom-0`：页签与卡片的相对几何全部由内容算出，字号 / 浏览器缩放 / 系统显示缩放
 *     怎么变都跟着走，不会错位（2026-10-25 用户：「如果放大，这个 40 就没效了」——
 *     所以 40 这类数不许再以任何形式回来）。流内元素天然落在容器内边距盒里
 *     （如 `FolderTabsCard` 的 `md:px-3`），页签与卡片左右自然对齐，不需要 inset 计算；
 *  2. **垂直几何是一套只依赖字号的公式，不是一堆拍出来的常数**（2026-10-25 用户：
 *     「目前的渲染效果是对的，我们要做的是把它公式化」）。唯一自由变量是 `globals.css
 *     :root` 的 `--ft-tab-font`（活动页签字号）；其余每个数都是 `font × k` 或几个这样的
 *     项相加，k 按 16px 标定（k × 16 = 行尾 px）。默认字号下与逐像素手调版完全一致；
 *     改字号则整条页签等比收放 —— 行距、上下留白（用户：「大字的边距也要加大」）、
 *     层次、抬起、藏深一起变，没有一处要手改。
 *
 *       ① 活动页签（盒模型自洽：1px 上边框 + 上下内边距 + 行高）
 *          `--ft-tab-line`        = font × leading(1.5)      = 24px   行高
 *          `--ft-tab-pad-top`     = font × 0.375             =  6px   上内边距（故意不对称：
 *          `--ft-tab-pad-bottom`  = font × 0.1875            =  3px   标签跟页签顶一起下移 3px）
 *          `--ft-tab-pad-sum`     = pad-top + pad-bottom     =  9px
 *          `--ft-tab-height`      = 1px + pad-sum + line     = 34px
 *       ② 页签条（流内；高 = 活动页签外沿 − 1px 接缝）
 *          `--ft-tab-top`         = font × 0.4375            =  7px   活动页签距条顶
 *          `--ft-tab-strip`       = top + height − 1px       = 40px
 *       ③ 非活动页签（层次 / 抬起 / 藏深，两条硬约束在公式里天然成立）
 *          `--ft-tab-step`        = font × 0.375             =  6px   层次：比活动页签低多少
 *          `--ft-tab-rise`        = top + step               = 13px   下沉量
 *          `--ft-tab-lift`        = font × 0.125             =  2px   hover 抬起量
 *          `--ft-tab-bury`        = font × 0.375             =  6px   底边藏进卡片后的深度
 *       ④ 字号派生 / 复用点
 *          `--ft-tab-font-sm`     = font × 0.75              = 12px   非活动页签字号
 *          `--ft-tab-leading`     1.5（无单位）→ 两种页签都写 `leading-[var(--ft-tab-leading)]`
 *          `--ft-tab-filter-h`    = height − step            = 28px   条右侧筛选按钮高
 *
 *     **全表唯一的绝对值是 1px**（边框、`-mb-px` 接缝）：发丝线跟着字号放大会在 DPR 2 上
 *     变粗一倍、卡片顶边出双线。比例一律写 `calc(font × k)` 而**不写 `em`**：`height /
 *     strip / filter-h` 会被页签之外的元素引用（FundShell 工具栏、筛选按钮），`em` 在那些
 *     元素上按各自字号解析，会得到另一个值。
 *     接缝 −1px 是**结构保证**：活动页签挂 `-mb-px` → 条高 = top + height − 1，内容板顶 = 条底。
 *
 *     非活动页签 = `mt-[var(--ft-tab-rise)]` + `self-stretch` + `-mb-[var(--ft-tab-bury)]`：
 *     高 = strip − rise + bury，**露出区 = strip − rise = 27px @16px**（与 bury 无关），底边落在
 *     卡片上缘以下 bury，被卡片（z-20 > 页签 z-10）整块盖住。
 *     a) `bury > lift`（0.375 > 0.125）：hover 抬起后底边仍在卡片后面，接缝永远露不出卡片
 *        上边框（曾出过「鼠标移上来下面露出底部线条了」）。这截深度不影响任何可见像素，
 *        2 / 4 / 10px 看起来完全一样（用户：「都会藏在卡片标题栏的后面」）。
 *     b) `lift < step`（0.125 < 0.375）：抬起后仍比活动页签低 `step − lift`，**永不高过它**
 *        （用户：「以前的非活动标签更低，即使鼠标移上去，也不会比活动标签高」）。
 *     文字在露出区内居中不写 `pt`：`items-center` + `pb-[var(--ft-tab-bury)]`
 *     （下内边距把内容盒还原成露出区），行高变化时自动重新居中（见第 10 条）。
 *     `mx-0.75`（左右各 3px）让相邻两个非活动页签间距 = 3+3+gap(6px) = 12px；
 *     **紧邻活动页签的那一侧收到 1px**（见第 7 条），让「非活动 → 活动」的间距 =
 *     gap(6px) + 1px = 7px，与凹角方块宽度一致。
 *     `items-start` 让活动页签「顶部固定、不增高」；
 *  3. 页签条**不设 position / z-index**：流内元素的 z-index 无效，也不会新建层叠上下文，
 *     活动页签的 z-30 与内容板的 z-20 在同一个层叠上下文里直接比较（见第 4 条）；
 *  4. 活动页签 z-30（盖内容板顶边框、与内容板连体），非活动页签 z-10（低于内容板 z-20：
 *     它底边那一格被内容板 1px 上边框压住，才读出「藏进卡片后面」的剪影，见第 9 条）——
 *     绝不能把非活动页签 z 提到内容板之上，否则会盖住内容板里的表单标签；
 *  5. 活动页签外阴影只能「向上」（负 offset + 小 blur），否则向下溢出把内容板顶部压暗；
 *  6. 内容板**四角恒为 12px 圆角**（`rounded-xl`），任何时候都不去圆角：活动页签无论排首位还是
 *     末位，都与内容板左右边缘留出 18px（见第 7 条），内容板两上角必然露在页签外侧——去掉任一
 *     上圆角都会露出一个直角台阶（与页签 8px 倒角并排，视觉上是「尖角」）；
 *  7. 活动页签左右**对称**：排首位时左缩进 18px（`ml-4.5`），排末位时右缩进 18px（`mr-4.5`），
 *     18px = 内容板倒角半径 12px + 页签凹角半径 6px——凹角外端正好落在内容板上圆角弧的起点
 *     （x = 内容板边缘 ∓ 12px），两条弧相切、接缝处不出现折角/断口。排在中间时不缩进，两侧
 *     凹角分别接到左右相邻页签的竖边 —— **前提是该侧间距正好等于凹角宽度 7px**：活动页签自身
 *     不带 margin，间距 = `gap`(6px) + 相邻非活动页签的该侧 margin，必须是 1px 而不是默认的
 *     3px（由 `folderTabClass` 的 `sideMargin` 按邻居是否活动自动切换）；放 3px 时间距 9px，
 *     多出的 2px 内容板上边框会露在凹角外，看着像「倒角旁边多一根短横线」；
 *  8. 非活动页签的**外侧边**（排在首位 / 末位，该侧就是内容板左右边缘）缩进 12px
 *     （`ml-3`/`mr-3`，= 内容板倒角半径），不压住内容板上角的圆弧；其余各边默认 3px
 *     （`ml-0.75`/`mr-0.75`），紧邻活动页签的一侧收到 1px（见第 7 条）；
 *  9. 非活动页签 `self-stretch` + `-mb-[var(--ft-tab-bury)]`：在页签条（内容高，= 活动页签
 *     外沿高）内拉伸，再把底边往卡片后面送 `--ft-tab-bury`（6px）→ 可见底边**恒等于内容板顶**，
 *     多出的 6px 被卡片盖住（hover 抬起 2px 后仍藏 4px，这就是不露缝的原因，见第 2 条）。
 *     **底边必须是直角、且不带下边框**（`rounded-t-[8px] border-b-0`，见 `folderTabClass`
 *     体内注释）：内容板那 1px 上边框（z-20 > 页签 z-10）横在页签底边上把它「切断」，
 *     读作页签继续藏进卡片后面 —— 这就是「从卡片后面探出的标签」的剪影。
 *     ⚠️ 不要改成四角圆角 + 全边框：那会变成一枚悬在卡片上缘的圆角矩形，
 *     2026-10-25 用户明确否决（原话「标签页变成圆角矩形了…视觉上象是藏在卡片后面」）。
 *     **页签条是流内内容高、页签只是被卡片盖住**——「标签页穿出卡片」（旧版 `bottom-0`
 *     铺满容器、非活动页签拉到容器底露灰底假页签）从此不可能发生；
 * 10. 非活动页签用 `flex items-center justify-center` + `pb-[var(--ft-tab-bury)]`：
 *     页签被拉伸到（露出区 + 藏进卡片的 6px），下内边距抵掉它，内容盒正好回到露出区，
 *     居中即「文字在露出区视觉居中」—— 这是**自动版 pt**：行高随字号变大时不用重算任何数
 *     （旧版 `items-start + pt-[5px]` 是手算的 (27 − 1 − 16) / 2，字号一变就偏）。
 *     ⚠️ 不要改成 `items-start` 而不同步 `pt`，文字会贴在露出区顶部；
 * 11. stretch 变体必须带 `min-w-0`：flex 项默认 `min-width:auto`，活动页签字号大（text-base）
 *     且标签长时会被内容撑宽、挤窄其他页签（宽度随文字缩放）——`min-w-0` 才能严格等宽平分；
 *     `overflow-hidden` 兜底只加在**非活动页签**与活动页签的**内层 span** 上（活动页签自身
 *     不能 overflow-hidden，见第 12 条）；
 * 12. 活动页签下缘用**外扩凹角**（inverted fillet）接内容板上沿横线，不用 `rounded-b-*`：
 *     上缘是凸圆角（连接页签外缘），下缘的弧要把「页签竖边」向外侧接到「内容板上沿横线」，
 *     由 `ft-tab-fillet` 的 `::before`/`::after` 两个伪元素画出（CSS 见 globals.css，含几何推导）。
 *     两个坑（改前必读 globals.css 注释）：① 两层都得用**内联 SVG**，硬色标 `radial-gradient`
 *     的圆环边界 Chromium 不抗锯齿，弧线会变锯齿台阶；② **填充层必须补满 7px 高**，把凹角落地段
 *     的内容板上边框抹掉，否则「圆弧落在一段多余横线上」，接不上卡片的大倒角圆弧。
 *     因此活动页签**不能** `overflow:hidden`（会裁掉按钮盒外的伪元素）——超长标签的裁切
 *     改由内层 `<span class="overflow-hidden">` 承担。
 * 13. 数值只有两处源头，**别处一律引用、不再手写**：
 *     a) **垂直几何 = `globals.css` 的那一套公式**（见第 2 条的完整表）：自由变量只有
 *        `--ft-tab-font`，其余 `font-sm / leading / line / pad-top / pad-bottom / pad-sum /
 *        height / top / strip / step / rise / lift / bury / filter-h` 全是它的 `calc()` 派生。
 *        类名里出现的 `var(--ft-tab-*)` 就是这些，源码里**没有第二个自由数字**（除 1px 发丝线）。
 *        改字号即整体收放：行距、上下留白、层次、抬起、藏深、条高、露出区、文字居中全部跟着走。
 *     b) **水平 / 圆角是设计度量，保留字面 px（且应该保留）**：`gap-1.5`(6px)、
 *        `mx-0.75`(3px)、`ml-px`(1px)、外侧缩进 12px（= 内容板圆角）、
 *        活动页签外侧缩进 18px（= 12 + 凹角半径 6）、页签上圆角 8px、凹角方块 7px、
 *        内容板圆角 12px（`rounded-xl`）。这些跟字形大小无关 —— 跟着放大反而会让凹角与
 *        内容板圆角错位（接缝出折角），所以它们**不**进令牌。
 *     c) 派生但不需要令牌的（结构自动）：条高由活动页签外沿顶出、非活动页签高度由
 *        `self-stretch` 得出、内容盒由 `pb` 还原成露出区。
 */

/**
 * 页签条容器类名。
 *
 * **流内元素，高度由页签内容撑开**（= 最高页签——活动页签——的外沿高），内容板紧跟其后。
 * 不写高度、不 absolute、不 `bottom-0`：全链路没有魔法数，字号 / 缩放变化时页签与卡片的
 * 相对几何由内容算出，不会错位（2026-10-25 用户：「如果放大，这个 40 就没效了」）。
 *
 * 历史包袱（都别再改回来）：
 *  - `absolute ... bottom-0` 铺满容器：容器比卡片高时（基金页可拖拽窗格、卡片内容比窗格矮），
 *    非活动页签的 `self-stretch` 会拉到容器底，在卡片下面露出一整条灰底「假页签」
 *    （用户反馈「标签页穿出了卡片」）；
 *  - `absolute ... h-10` 固定 40px 带：不穿出了，但 40 是写死的——放大 / 改字号就失灵，
 *    且非活动页签会变成一枚悬在卡片上缘的圆角矩形（用户否决）。
 * 现在：页签条内容高 → 非活动页签底边恒 = 卡片上缘（被卡片 1px 上边框切断，
 * 见第 9 条），活动页签用 `-mb-px` 把接缝 −1px 变成结构保证（见 `folderTabClass`）。
 */
export const FOLDER_TAB_STRIP = "flex items-start gap-1.5";

/** 内容板基础类名（圆角由 folderTabPanelClass 按活动页签位置追加）。 */
const FOLDER_TAB_PANEL =
  "relative z-20 rounded-xl border border-slate-300 bg-[#fbfaf7] p-4 shadow-[0_10px_24px_rgba(15,23,42,0.10)]";

type TabVariant = "stretch" | "min";

/**
 * 邻居页签是否活动。手写调用点（不用 <FolderTabs> 组件时）用 folderTabNeighbors 计算。
 */
type FolderTabNeighbors = {
  /** 左邻页签是否为活动页签。 */
  prevActive?: boolean;
  /** 右邻页签是否为活动页签。 */
  nextActive?: boolean;
};

/**
 * 计算某个页签左右邻居的活动状态（供手写调用点传给 folderTabClass）。
 * @param order 页签 id 的**实际渲染顺序**
 */
export function folderTabNeighbors(order: readonly string[], id: string, activeId: string): FolderTabNeighbors {
  const index = order.indexOf(id);
  if (index < 0) return {};
  return {
    prevActive: index > 0 && order[index - 1] === activeId,
    nextActive: index < order.length - 1 && order[index + 1] === activeId,
  };
}

/**
 * 页签按钮类名。
 * @param active 是否活动页签
 * @param atEnd 是否排在最末（最右）
 * @param variant "stretch" 页签组内等宽平分（配合 `FolderTabRuler` 时组宽 = N × 最长标签宽）；
 *                "min" 最小宽——目前已无调用点，保留仅为兼容可能的「不填满」场景
 * @param atStart 是否排在首位。活动页签排首位时左缩进 18px（`ml-4.5`），与排末位时的 `mr-4.5`
 *                左右对称——凹角外端落在内容板上圆角弧起点，两条弧相切；
 *                非活动页签在首位 / 末位时该侧缩进 12px（`ml-3`/`mr-3`，= 内容板倒角半径）
 * @param neighbors 左右邻居是否活动。紧邻活动页签的那一侧 margin 必须从 3px 收到 1px，
 *                  详见函数体内 `sideMargin` 的推导（2026-10-05 用户反馈「中间页签左侧倒角多一根横线」）
 */
export function folderTabClass(
  active: boolean,
  atEnd: boolean,
  variant: TabVariant = "stretch",
  atStart = false,
  neighbors: FolderTabNeighbors = {},
) {
  const width = variant === "stretch" ? "flex-1 basis-0 min-w-0" : "min-w-[7.5rem]";
  if (active) {
    return [
      // 上缘保留凸圆角；下缘**不用** `rounded-b-*`——那会让竖边往内收、与内容板上沿接不上。
      // 改由 `ft-tab-fillet` 的两个伪元素画「外扩凹角」，把竖边向外侧接到内容板上沿横线
      // （几何与色值见 globals.css 的 .ft-tab-fillet 注释）。
      // 凹角必须画到按钮盒外，故这里**不能** overflow-hidden（超长标签改由内层 span 裁切）。
      // 页签高 / 顶距 / 上下内边距全部来自 `--ft-tab-*` 令牌（见文件头第 2 条），
      // 类名里不再写字面 px；改令牌即可，这里不用动。
      // **接缝 −1px 靠 `-mb-px`（下边距 −1px）结构保证**：页签条是流内内容高
      // （= `--ft-tab-top` + `--ft-tab-height` − 1），内容板顶 = 页签条底 → 页签底恒比板顶低
      // 1px，与字号无关（旧版靠 `pt-10`(40) 对 `mt-7+34=41` 凑等式，放大就露白缝；
      // 2026-10-25 用户：「如果放大，这个 40 就没效了」）。
      // 上下内边距不对称（6 / 3）是有意的：让标签跟着页签顶下移 3px，而不是随高度收缩各让 1.5px。
      // 底色 = 内容板底色 = 表头底色：#fbfaf7，三处必须一致（表头那份由 AdvancedDataTable 的
      // `ADVANCED_TABLE_HEAD_SURFACE_CLASS` 提供，这里不 import 它是为了不把 ADT 带进登录页的包）。
      `relative z-30 mt-[var(--ft-tab-top)] -mb-px ${width} rounded-t-[8px] border border-b-0 border-slate-300 bg-[#fbfaf7] px-4 pt-[var(--ft-tab-pad-top)] pb-[var(--ft-tab-pad-bottom)] text-[length:var(--ft-tab-font)] leading-[var(--ft-tab-leading)] font-semibold text-slate-800 shadow-[0_-2px_3px_rgba(15,23,42,0.06)]`,
      "ft-tab-fillet",
      // 排首位/末位时的缩进 = 内容板倒角半径(12px) + 页签凹角半径(6px) = 18px。
      // 凹角外端正好落在内容板上圆角弧的起点上，两条弧相切、不会打架；
      // 若缩进小于此值，凹角会撞进内容板的圆角弧里，接缝处出现折角/断口。
      // 左右必须同时给，否则「左直线、右曲线」不对称（首位页签曾因此只画右凹角）。
      atStart ? "ml-4.5" : "",
      atEnd ? "mr-4.5" : "",
    ].filter(Boolean).join(" ");
  }
  // 非活动页签 `mt-[var(--ft-tab-rise)]` = 活动页签 `--ft-tab-top` **+ `--ft-tab-step`(6px)**：
  // 跟随关系，靠这 6px 表达层次（旧版登录页就是 13 对 7，用户：「以前的非活动标签更低，
  // 即使鼠标移上去，也不会比活动标签高」）。条高由活动页签外沿顶出，故 `self-stretch` 得
  // 「`--ft-tab-strip` − `--ft-tab-rise`」，再挂 `-mb-[var(--ft-tab-bury)]` 把底边**送进卡片
  // 后面 6px**，被卡片（z-20）盖住：hover 抬起 `--ft-tab-lift`(2px) 后仍藏 4px，接缝处露不出
  // 卡片上边框那条线（2026-10-25 用户：移上来「下面露出底部线条了」）。藏深与抬起量**解耦** ——
  // 藏多深都不影响外观（用户：「2px、4px、10px，效果其实都一样，因为都会藏在卡片后面」），
  // 只要 bury > lift；而 lift 必须 < step，否则 hover 会追平活动页签、层次失效。
  // 文字居中不写 `pt`：`items-center` + `pb-[var(--ft-tab-bury)]` 把内容盒还原成露出区，
  // 行高（`--ft-tab-line` 用 rem）变了自动重新居中；句柄是「内边距抵消多出的那截」。
  // 左右 margin：默认各 3px（`ml-0.75`/`mr-0.75`），相邻两个**非活动**页签的间距 =
  // 3 + gap(6px) + 3 = 12px。
  // ⚠️ 但**紧邻活动页签的那一侧必须收到 1px（`ml-px`/`mr-px`）**：活动页签两侧的凹角方块只有
  // 7px 宽（left/right:-7px），它的外端必须正好落在相邻页签的竖边上才能接住；
  // 间距 = gap(6px) + 邻居 margin，取 3px 时是 9px > 7px，中间那约 2px 的内容板上边框会整段
  // 露在凹角外侧 —— 就是用户看到的「倒角旁边多出一根短横线」（中间页签两侧都会出现）。
  // 取 1px 时 6 + 1 = 7px，弧线外端与相邻页签竖边相接，多余横线消失。
  // **外侧边**（`atStart` / `atEnd`：该侧没有相邻页签，即页签条 = 内容板的左/右边缘）缩进
  // 一个**内容板倒角半径** 12px（`ml-3`/`mr-3`）：非活动页签不得压住内容板上角的圆弧，
  // 缩进 12px 后它的竖边正好落在圆角弧的起点上（与活动页签 18px = 12 + 凹角半径 6 同一原点）。
  const sideMargin =
    variant === "stretch"
      ? `${neighbors.prevActive ? "ml-px" : atStart ? "ml-3" : "ml-0.75"} ${neighbors.nextActive ? "mr-px" : atEnd ? "mr-3" : "mr-0.75"}`
      : "mx-0.75";
  return [
    // 底边**直角、且不带下边框**（`rounded-t-[8px] border-b-0`）：内容板那 1px 上边框
    // （z-20，压在页签 z-10 之上）正好横在页签底边上，把页签「切断」——读作页签继续藏进
    // 卡片后面，与登录页沿用多年的「从卡片后面探出的标签」同一剪影（2026-10-25 与原版
    // 并排实测：像素级一致）。
    // ⚠️ 不要改回「四角圆角 + 全边框」：那会变成一枚悬在卡片上缘的完整圆角矩形 ——
    // 2026-10-25 用户明确否决（「标签页变成圆角矩形了…视觉上象是藏在卡片后面」：
    // 要的是「象是藏在后面」的剪影，不是一枚圆角小签）。
    // 页签高度、下沉量、hover 抬起 / 藏进卡片的量全部是变量派生（`--ft-tab-rise` /
    // `--ft-tab-lift` / `--ft-tab-bury`），任何卡片高度、任何字号下都只藏 bury，也不会穿出卡片。
    `relative z-10 mt-[var(--ft-tab-rise)] -mb-[var(--ft-tab-bury)] self-stretch ${width} flex items-center justify-center overflow-hidden whitespace-nowrap rounded-t-[8px] border border-b-0 border-slate-300 bg-slate-200 ${sideMargin} px-4 pb-[var(--ft-tab-bury)] text-[length:var(--ft-tab-font-sm)] leading-[var(--ft-tab-leading)] font-medium text-slate-500 shadow-[0_2px_4px_rgba(15,23,42,0.08)] hover:-translate-y-[var(--ft-tab-lift)] hover:bg-slate-100`,
  ].join(" ");
}

/**
 * 内容板类名。四角恒为 12px 圆角，**不去任何圆角**。
 *
 * 活动页签左右都缩进 18px（见 folderTabClass 的 `ml-4.5`/`mr-4.5`），内容板两上角必然露在
 * 页签外侧；去掉任一上圆角都会露出一个直角台阶（与页签的 8px 倒角并排，视觉上是「尖角」）。
 * 保留 12px 圆角才能与页签凹角自然相切收口。
 */
export function folderTabPanelClass() {
  return FOLDER_TAB_PANEL;
}

type FolderTabsItem = {
  id: string;
  label: ReactNode;
};

/**
 * 隐形量尺（invisible ruler）：让**同一组**页签等宽、且宽度只按最长标签占位。
 *
 * 用法：把本组件放进每个页签的内层 span（活动页签裁切用的那层）里，页签本身用
 * `folderTabClass(..., "stretch", ...)`。原理：量尺把**全部**标签按活动页签的字号
 * （`text-base` / `font-semibold`）叠在同一个网格单元里，于是它的 max-content 宽 = 最长标签宽；
 * 每个页签里放同一份量尺 → 各页签的 max-content 宽都相等 → 页签组自身宽度 = N × 最长标签宽，
 * 配合 `flex-1 basis-0` 平分即得严格等宽；页签组不做 `w-full`，所以整组靠左、不铺满整行。
 *
 * `h-0 overflow-hidden` 保证它只参与宽度计算、不占页签高度（页签高仍由 pt/pb + 行高决定）。
 * 列用 `minmax(0, max-content)`：量尺的 **max-content** 仍是「最长标签」（决定等宽），但
 * **min-content 为 0**、可以被压缩 —— 否则量尺会把每个页签的最小宽度锁死在最长标签上，
 * 窄屏下页签组撑破容器、末尾页签点不到。压缩时标签由页签内层 span 的 ellipsis 裁切。
 *
 * 另有一枚**下限探针** `RULER_MIN_PROBE`：四个汉字宽，保证再短的标签（如「买入」「赎回」）
 * 也不会窄成一条 —— 太短的标签不好看。探针与真实标签同字号同字体，所以它量出来的就是
 * 「四个字的宽度」；同样只抬高 max-content，`<sm` 窄屏仍可继续压缩。
 */
const RULER_MIN_PROBE = "宽度量尺";

export function FolderTabRuler({ labels }: { labels: readonly ReactNode[] }) {
  return (
    <span className="grid h-0 grid-cols-[minmax(0,max-content)] overflow-hidden text-[length:var(--ft-tab-font)] leading-[var(--ft-tab-leading)] font-semibold" aria-hidden="true">
      <span className="col-start-1 row-start-1 whitespace-nowrap">{RULER_MIN_PROBE}</span>
      {labels.map((label, index) => (
        <span key={index} className="col-start-1 row-start-1 whitespace-nowrap">{label}</span>
      ))}
    </span>
  );
}

/**
 * 文件卡片式页签组件。
 *
 * 用法：
 *   <FolderTabs
 *     tabs={[{ id: "local", label: "本地账户" }, { id: "mmh", label: "MMH 用户" }]}
 *     activeId={loginMode}
 *     onChange={(id) => switchLoginMode(id)}
 *     variant="stretch"
 *     panelClassName="space-y-4"
 *   >
 *     ...内容板里的表单...
 *   </FolderTabs>
 *
 * 注意：页签条是**流内**元素（`FOLDER_TAB_STRIP`，高 = 页签内容，见文件头第 1、2 条），
 * 内容板跟在它后面——这里不再有 `pt-10`，卡片顶边由页签条实际高度决定；
 * 重置/注册子态要收起页签条时，由调用方自行判断是否渲染这一层（见登录页的 showReset 分支）。
 */
export function FolderTabs({
  tabs,
  activeId,
  onChange,
  variant = "stretch",
  stripClassName = "",
  panelClassName = "",
  renderTab,
  children,
}: {
  tabs: FolderTabsItem[];
  activeId: string;
  onChange: (id: string) => void;
  variant?: TabVariant;
  stripClassName?: string;
  panelClassName?: string;
  renderTab?: (tab: FolderTabsItem, active: boolean, atEnd: boolean) => ReactNode;
  children: ReactNode;
}) {
  const lastIndex = tabs.length - 1;
  return (
    <div className="relative">
      <div className={`${FOLDER_TAB_STRIP} ${stripClassName}`.trim()}>
        {tabs.map((tab, index) => {
          const active = tab.id === activeId;
          const atEnd = index === lastIndex;
          const prevActive = index > 0 && tabs[index - 1]?.id === activeId;
          const nextActive = index < lastIndex && tabs[index + 1]?.id === activeId;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onChange(tab.id)}
              className={folderTabClass(active, atEnd, variant, index === 0, { prevActive, nextActive })}
            >
              {/* 活动页签不能 overflow-hidden（下缘凹角要画到按钮盒外），
                  故把「裁切超长标签」的兜底挪到内层 span。 */}
              <span className="relative block overflow-hidden whitespace-nowrap">
                {renderTab ? renderTab(tab, active, atEnd) : tab.label}
              </span>
            </button>
          );
        })}
      </div>
      <div className={`${folderTabPanelClass()} ${panelClassName}`.trim()}>
        {children}
      </div>
    </div>
  );
}
