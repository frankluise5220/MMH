"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";

import { FOLDER_TAB_STRIP, FolderTabRuler, folderTabClass } from "@/app/login/FolderTabs";
import { AccountBatchImportButton } from "@/components/settings/AccountBatchImportButton";
import {
  fetchSettingsAccountData,
  SETTINGS_DATA_CHANGED_EVENT,
  type SettingsDataChangedDetail,
} from "@/lib/client/settingsCache";
import { useI18n } from "@/lib/i18n";

type BasicDataImportOptions = Awaited<ReturnType<typeof fetchSettingsAccountData>>;

const BASIC_DATA_TABS = [
  { href: "/settings/family-members", labelKey: "settings.familyMembers" },
  { href: "/settings/counterparties", labelKey: "settings.counterparties" },
  { href: "/settings/institutions", labelKey: "settings.institutions" },
  { href: "/settings/tags", labelKey: "settings.tags" },
] as const;

/**
 * 基本资料四个子页的公共表头：FT（文件卡片）页签条。
 *
 * 页签只是**导航**（路由切换），内容板仍在各页自己的 `<SettingsSection>` 上：调用方要把
 * 本组件与那张卡片放进同一个 `relative` 容器（中间不留 `gap`），页签条才是流内元素、
 * 紧贴卡片上沿，非活动页签被卡片的 `z-20` 盖住藏进卡片后面（几何不变量见
 * `@/app/login/FolderTabs` 文件头）。卡片侧需圆角 12px / 边框 slate-300，与页签凹角相切。
 *
 * 2026-11-04 起「导出模板 / 导入 EXCEL」不再挂在这里：用户要求把它们放进卡片标题栏、
 * 紧挨「新增」左侧（见 `BasicDataImportExportActions`）。`children` 仍保留为通用插槽，
 * 但四个子页已不再传。
 *
 * 宽度适配（只动水平内边距与字号两个水平量，**不动任何垂直常数**，公式与接缝都不受影响）。
 *
 * 页签组**按内容定宽、靠左，不均分整行**（用户：「不需要均分整行，每列稍微紧凑一点」）：
 * 页签条用 `shrink`（basis auto）而不是 `flex-1`，等宽由每个页签里的 `FolderTabRuler` 提供
 * ——各页签的 max-content 都等于最长标签宽，组宽因此 = N × 最长标签宽。16px 字号 + 页签内边距
 * 10px 时每列 86px、四列共 394px（1440px 视口内容列 624px 里右侧留白）。
 * 若仍用 `flex-1`，四个页签会各拉到 92px 且被容器压缩，「家庭成员 / 往来对象」就会被内层
 * span 裁成半截字（2026-11-04 曾出现该问题）。
 *
 * 内容列宽度不跟着视口线性变化（1440px→624px、1180px→684px、768px→272px），所以按**容器宽度**
 * 分档退让（`@container`），只在极窄时才降档：
 * - 内容列 ≥ 416px：16px 字号 + 内边距 10px（每列 86px，四列 394px）；
 * - 304~416px：字号 13px + 内边距 8px（每列 70px，四列 330px；390px 手机、834px 窄窗都够）；
 * - < 304px：字号 12px + 内边距 6px（每列 62px，四列 298px）。
 * 页签内边距用 `> [role=tab]` 子选择器覆盖（权重高于 `px-4`，不必 `!`）。
 *
 * 注意：这里改的 `--ft-tab-font` 只作用在**本页签条**上，而 `--ft-tab-pad-*` / `-step` /
 * `-bury` 等派生变量在 `:root` 就已经按 1rem 代换完（自定义属性是在声明处求值后继承的），
 * 所以实际效果是「文字与其行高变小、页签盒子的上下留白与藏深保持 16px 版的常数」——
 * 页签条因此只略矮（手机 34px / 桌面 40px），垂直公式、`-mb-px` 接缝和三条硬约束都不受影响。
 * 只有当 `--ft-tab-font` 在 `:root` 上被整体改掉时，整条页签才会等比收放。
 */
/**
 * 页签里的「隐性量尺 + 文字」。
 *
 * 单独抽成组件只为一件事：`useLinkStatus()` 必须在 `<Link>` 的**后代**里调用才拿得到
 * 导航状态（Provider 由 Link 内部渲染）。拿到后只做一件事——切换途中把文字淡到 60%，
 * 给一个「点了、正在取下一页」的回应。
 *
 * ⚠️ 不要再靠段级 `loading.tsx` 做这件事：四个子页共用一个整页骨架，点一下页签
 * 内容区会被灰色骨架整块顶掉再回来（2026-11-04 用户：「切换标签整个页面都闪，
 * 不应该这样」）。没有那个边界时 Next 会**保留旧页面**直到新 RSC 就绪、再一次性替换，
 * 中间没有空白帧；反馈就靠这里这点淡出（以及左侧导航那颗转圈）。
 */
function BasicDataTabContent({ labels, label }: { labels: readonly string[]; label: string }) {
  const { pending } = useLinkStatus();
  return (
    <span
      className={`relative block overflow-hidden text-ellipsis whitespace-nowrap transition-opacity duration-150 ${pending ? "opacity-60" : ""}`}
      aria-busy={pending || undefined}
    >
      <FolderTabRuler labels={labels} />
      {label}
    </span>
  );
}

export function BasicDataSubmenuHeader({ children }: { children?: ReactNode }) {
  const pathname = usePathname();
  const { t } = useI18n();
  const lastIndex = BASIC_DATA_TABS.length - 1;
  const activeIndex = BASIC_DATA_TABS.findIndex((item) => pathname === item.href);
  const tabLabels = BASIC_DATA_TABS.map((item) => t(item.labelKey));

  return (
    // 页签条**不刷底色**（2026-11-12 用户：「页签背景有一个与卡片同宽的长条形底色，去掉」）：
    // 2026-11-04 曾在这层整行刷卡片底色，并用 `pb-3 -mb-3` 多长 12px 去填卡片上圆角外侧的死角；
    // 底色撤销后那 12px 没有意义，一并去掉（两者相互抵消，排版位置不变）。
    <div className="@container shrink-0">
      <div className="relative flex items-end gap-2 @max-[26rem]:[--ft-tab-font:0.8125rem] @max-[19rem]:[--ft-tab-font:0.75rem]">
        {/* 页签组靠左、**不铺满整行**：`shrink`（basis auto）让它按内容宽排布，等宽由每个页签里的
            `FolderTabRuler` 提供（各页签 max-content 都等于最长标签宽 → 组宽 = N × 最长标签宽）。 */}
        <div
          className={`${FOLDER_TAB_STRIP} min-w-0 max-w-full shrink [&>[role=tab]]:px-2.5 @max-[26rem]:[&>[role=tab]]:px-2 @max-[19rem]:[&>[role=tab]]:px-1.5`}
          role="tablist"
          aria-label={t("settings.basicDataSubmenu")}
        >
          {BASIC_DATA_TABS.map((item, index) => {
            const active = index === activeIndex;
            return (
              <Link
                key={item.href}
                href={item.href}
                prefetch={false}
                role="tab"
                aria-selected={active}
                className={folderTabClass(active, index === lastIndex, "stretch", index === 0, {
                  prevActive: index > 0 && index - 1 === activeIndex,
                  nextActive: index < lastIndex && index + 1 === activeIndex,
                })}
              >
                {/* 活动页签不能 overflow-hidden（凹角画在盒子外），裁切交给内层 span。
                    隐形量尺让四个页签都按「最长标签」定宽，得到等宽但不铺满的紧凑列；
                    文字居中由 `folderTabClass` 的 `text-center` 负责（span 因量尺而比文字宽）。 */}
                <BasicDataTabContent labels={tabLabels} label={t(item.labelKey)} />
              </Link>
            );
          })}
        </div>
        {children ? (
          <div className="ml-auto flex h-[var(--ft-tab-strip)] shrink-0 items-start gap-2 pt-[var(--ft-tab-rise)]">{children}</div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 基本资料页的「导出模板 / 导入 EXCEL」入口。
 *
 * 复用账户页那套批量导入组件，只是基础资料（机构 / 往来对象 / 家庭成员 / 基准币种）由这里
 * 自己按需取（`fetchSettingsAccountData` 带缓存，四个子页共用一份请求）。
 *
 * 2026-11-04 用户：「把导出与导入放到新增左边，鼠标放上去的时候提示这是整个基础资料的
 * 模板导出和导入」——所以不再挂 FT 页签条右端（`BasicDataSubmenuHeader` 的 children），
 * 而是由各页放进 `SettingsSection.actions` 的 `addButton` 之前，并带 tooltip 说明作用域。
 */
export function BasicDataImportExportActions({ onImported, className }: { onImported?: () => void; className?: string }) {
  const { t } = useI18n();
  const [options, setOptions] = useState<BasicDataImportOptions | null>(null);

  useEffect(() => {
    let alive = true;
    const load = (force = false) => {
      void fetchSettingsAccountData(force ? { force: true } : undefined)
        .then((value) => {
          if (alive) setOptions(value);
        })
        .catch(() => null);
    };
    // Import can create institutions/counterparties, so the options snapshot
    // frozen at mount time must refetch when the settings data changes.
    const onSettingsChanged = (event: Event) => {
      const scope = (event as CustomEvent<SettingsDataChangedDetail>).detail?.scope ?? "all";
      if (scope === "accounts" || scope === "all") load(true);
    };
    load();
    window.addEventListener(SETTINGS_DATA_CHANGED_EVENT, onSettingsChanged as EventListener);
    return () => {
      alive = false;
      window.removeEventListener(SETTINGS_DATA_CHANGED_EVENT, onSettingsChanged as EventListener);
    };
  }, []);

  if (!options) return null;

  return (
    <div className={className ? `${className} items-center gap-2` : "flex items-center gap-2"}>
      {/* 放进卡片标题栏后与「新增」等按钮同高（不再用 compact 的 28px 页签条高度）。 */}
      <AccountBatchImportButton
        exportTemplateTitle={t("settings.basicData.templateTip")}
        importExcelTitle={t("settings.basicData.importTip")}
        groups={options.groups}
        institutions={options.institutions}
        counterparties={options.counterparties ?? []}
        baseCurrency={options.baseCurrency ?? "CNY"}
        onImported={() => onImported?.()}
      />
    </div>
  );
}
