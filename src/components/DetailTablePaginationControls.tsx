"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { DateStepper } from "@/components/DateStepper";
import type { DetailPagination } from "@/lib/client/use-detail-pagination";

/**
 * 控件只认一个东西：那个唯一的分页状态点。页码 / 页大小 / 是否全部 / 是否自适应
 * 和对应事件全部从 `pager` 上取，不再由 9 个调用点各抄一遍十几行 props ——
 * 抄一遍就多一处可以传错的映射。
 *
 * 翻页的**四个方向都在**（最前页 / 上一页 / 下一页 / 末页），但**不做成按钮**
 * （2026-10-31 用户：「收紧一点，不要四个按钮」→ 去掉首末页 →「要有最前页，前一页这个功能，
 * 但是不要以按钮的形式出现」）。两轮合起来要的是：功能别丢，但别让四个带框带底的方块并排
 * 抢走注意力。所以箭头只保留字形本身 —— 无边框、无底色、无阴影，常态 `text-slate-500`、
 * 悬停变深（`slate-800`）、到头的方向淡到 `text-slate-300`；命中区仍是 24×24（`h-6 w-6`），手指点得到，
 * 眼睛看到的只是四个箭头（2026-10-31 追加：「翻面的大于号小于号大一点，包括书名号」→
 * 字形 12px → 14px，`«`/`»` 一起放大；命中区不动，所以只是箭头看着更清楚，整条栏不会变宽）。
 *
 * 再追加「竖向变大30%试试」→ 只拉高不拉宽：14×14 的图元改成 14×18（`h-[18px] w-3.5`），
 * 并加 `preserveAspectRatio="none"` 让 viewBox 24×24 非等比铺满，否则 SVG 默认等比缩放，
 * 改高度只会得到 14×14 居中，等于没改。钉子是一台 24px 高的命中区，18px 仍留 3px 上下留白；
 * 竖着的笔画（含箭头的横段）会被拉粗约 1.3 倍，视觉上箭头更「尖挺」，但宽度不变。
 * 首末页（`«` `»`）不再省掉：输入框虽然能跳页，但「回第一页」是最高频的动作，
 * 不该要求先清空再敲数字。
 * 连带收紧：容器 `gap-1`，箭头/输入框/下拉统一 `h-6`，输入框 `w-8`（去掉外框后 36px 会在
 * 「‹ 3」和「3 /」两处各留一段说不清的空当）。
 */
type DetailTablePaginationControlsProps = {
  pager: Pick<
    DetailPagination,
    | "rows" | "all" | "safePage" | "totalPages" | "canPrev" | "canNext" | "autoFit"
    | "select" | "showAll" | "goPage" | "restoreFit"
  >;
  pageSizeOptions?: readonly number[];
  /**
   * 「全部」仍按页浏览：总数超过本地全量阈值时改由服务端分页，下拉照样显示
   * 「全部」（不回跳成 40），但页码 / 前后翻页必须保留 —— 否则用户选了全部
   * 只能看到当前这一页，看起来就是「没生效」。
   *
   * 缺省 = 不在「全部」模式，与 `pager.all` 反相。
   */
  paged?: boolean;
  /** Optional: jump to the page containing the given date (YYYY-MM-DD). */
  onLocateDate?: (dateYmd: string) => void;
  locateDateBusy?: boolean;
};

// 箭头 = 纯字形，没有按钮外壳：不画边框、不铺底色，只靠颜色表达「可点 / 到头了」。
// 命中区留 24×24，避免为了好看把可点区域缩到 12px。
function pageArrowClass(enabled: boolean) {
  return enabled
    ? "inline-flex h-6 w-6 items-center justify-center rounded text-slate-500 transition-colors hover:text-slate-800"
    : "inline-flex h-6 w-6 cursor-not-allowed items-center justify-center rounded text-slate-300";
}

export function DetailTablePaginationControls({
  pager,
  pageSizeOptions = [40, 80],
  paged = !pager.all,
  onLocateDate,
  locateDateBusy = false,
}: DetailTablePaginationControlsProps) {
  // 只做一次改名，下面整块渲染逻辑不用跟着改。
  const {
    rows: pageSize,
    all: detailAll,
    safePage,
    totalPages,
    canPrev,
    canNext,
    autoFit,
    select: onPageSizeChange,
    showAll: onShowAll,
    goPage: onPageChange,
    restoreFit: onAutoFit,
  } = pager;
  const { t } = useI18n();
  const [pageInput, setPageInput] = useState(() => String(safePage));
  const [locateDate, setLocateDate] = useState("");

  useEffect(() => {
    setPageInput(String(safePage));
  }, [safePage]);

  const commitPageInput = () => {
    const parsed = parseInt(pageInput.trim(), 10);
    const clamped = Number.isFinite(parsed) ? Math.min(Math.max(1, parsed), totalPages) : safePage;
    setPageInput(String(safePage));
    if (paged && clamped !== safePage) onPageChange(clamped);
  };

  // 键盘分段修改已选日期时，每敲一位都是一次「完整日期」变更（如把 2026 改成
  // 2027 会先经历 0002→0020→0202→2027）。逐次发起定位会让页面随中间值跳页、
  // 并在输入过程中反复禁用输入框（表现为「第二次就打不了字」）。收敛为停顿后
  // 用最终值定位一次；日历点选本就是最终值，仅多等 300ms，无感。
  const locateTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (locateTimerRef.current != null) window.clearTimeout(locateTimerRef.current);
  }, []);

  const handleLocateDateChange = (nextValue: string) => {
    if (nextValue === locateDate) return;
    setLocateDate(nextValue);
    if (locateTimerRef.current != null) {
      window.clearTimeout(locateTimerRef.current);
      locateTimerRef.current = null;
    }
    if (!nextValue) return;
    locateTimerRef.current = window.setTimeout(() => {
      locateTimerRef.current = null;
      onLocateDate?.(nextValue);
    }, 300);
  };

  return (
    <div className="flex items-center gap-1 text-xs tabular-nums">
      <span className="text-slate-500">{t("pagination.perPage")}</span>
      <select
        value={detailAll ? "all" : autoFit ? "auto" : String(pageSize)}
        onChange={(event) => {
          const { value } = event.target;
          if (value === "all") {
            onShowAll();
            return;
          }
          if (value === "auto") {
            onAutoFit();
            return;
          }
          const nextSize = parseInt(value, 10);
          if (Number.isFinite(nextSize) && nextSize > 0) onPageSizeChange(nextSize);
        }}
        title={t("pagination.perPage")}
        aria-label={t("pagination.perPage")}
        className="h-6 rounded border border-slate-200 bg-white px-1 text-slate-700 hover:bg-slate-50"
      >
        <option value="auto">{t("pagination.autoFit")}</option>
        <option value="all">{t("common.all")}</option>
        {!detailAll && !autoFit && !pageSizeOptions.includes(pageSize) ? <option value={String(pageSize)}>{pageSize}</option> : null}
        {pageSizeOptions.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
      {paged ? <span className="text-slate-500">{t("pagination.items")}</span> : null}
      <span className="text-slate-300">|</span>
      <button type="button" onClick={() => onPageChange(1)} disabled={!canPrev} className={pageArrowClass(canPrev)} title={paged ? t("creditBill.firstPage") : t("pagination.allMode")}>
        <ChevronsLeft className="h-[18px] w-3.5" preserveAspectRatio="none" />
      </button>
      <button type="button" onClick={() => onPageChange(safePage - 1)} disabled={!canPrev} className={pageArrowClass(canPrev)} title={paged ? t("creditBill.prevPage") : t("pagination.allMode")}>
        <ChevronLeft className="h-[18px] w-3.5" preserveAspectRatio="none" />
      </button>
      {paged ? (
        <>
          {/* 页码与总页数是**同一句话**：同 12px / 同字重 / 同 slate-600（2026-10-31 用户：
              「页与总页数字体相差太大 不协调」）。当时的差不是字号，是色差三档。
              现在连「外框」也不要了（用户：「当前页显示有一个外框，使得其中的数字在视觉上比总页数低」）。
              先按元素自己的盒子量：`3` 与 `12` 的墨迹都是 y 48.25–56.75，看着像「只是那圈 24px
              方框的锅」—— 框底落在基线下方，眼睛会把数字往里带。
              社区主流的紧凑分页也是这个路子：Quasar 的 inputbox 模式、Ant Design 的 simple 模式
              （`当前页 / 总页数` 纯文本）、Red Hat 的页码 + 跳转框，页码在静止态都不画框。
              所以这里边界改成 `border-transparent`（宽度保留 1px，悬停/聚焦只换颜色，不产生位移），
              悬停露出 slate-200 细边当作「这里能改」的提示，聚焦才变蓝。
              去掉框之后用户仍说「当前页还是比总页数低」——这次是真的，之前量错了：按元素自己的盒子量，
              两边都在正中；按页面绝对坐标量，`<input>` 里的数字比相邻 `<span>` 低整整 1px（DPR 1/1.25/1.5/2/3/4
              实测 1.00–1.33px，`<span>` 版本恒为 0）。原因是 Chrome 在内联编辑框里做垂直居中时把 1px 边框
              也算进了可用高度，24px 高、上下各 1px 边框的输入框，文字落点比 flex 居中的行盒低一点。
              修法：`leading-6` 把输入框内部行盒直接撑到与 24px 高度等值，不再依赖那套居中算法 ——
              六种 DPR 复测 Δ 全部归零，且边框仍是 1px（悬停/聚焦只换颜色，布局零位移）。 */}
          <input
            type="text"
            inputMode="numeric"
            value={pageInput}
            onChange={(event) => setPageInput(event.target.value.replace(/\D/g, "").slice(0, 6))}
            onBlur={commitPageInput}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                (event.target as HTMLInputElement).blur();
              }
            }}
            title={t("pagination.pageInputTitle")}
            aria-label={t("pagination.pageInputTitle")}
            className="h-6 w-8 rounded border border-transparent bg-transparent text-center text-xs leading-6 text-slate-600 outline-none transition-colors hover:border-slate-200 hover:bg-white focus:border-blue-300 focus:bg-white disabled:cursor-not-allowed disabled:border-transparent disabled:bg-transparent disabled:text-slate-300"
          />
          <span className="text-xs text-slate-600">/ {totalPages}</span>
        </>
      ) : null}
      <button type="button" onClick={() => onPageChange(safePage + 1)} disabled={!canNext} className={pageArrowClass(canNext)} title={paged ? t("creditBill.nextPage") : t("pagination.allMode")}>
        <ChevronRight className="h-[18px] w-3.5" preserveAspectRatio="none" />
      </button>
      <button type="button" onClick={() => onPageChange(totalPages)} disabled={!canNext} className={pageArrowClass(canNext)} title={paged ? t("creditBill.lastPage") : t("pagination.allMode")}>
        <ChevronsRight className="h-[18px] w-3.5" preserveAspectRatio="none" />
      </button>
      {onLocateDate ? (
        <>
          <span className="text-slate-300">|</span>
          <div className="w-fit" title={t("pagination.locateDateTitle")}>
            <DateStepper
              compact
              value={locateDate}
              onChange={handleLocateDateChange}
              className={`!h-6 !min-h-0 !w-[7.5rem] !rounded !pl-1 !pr-6 !text-xs ${locateDateBusy ? "!bg-slate-50" : ""}`}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}
