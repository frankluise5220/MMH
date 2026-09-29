"use client";

import { createPortal } from "react-dom";
import { useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useI18n } from "@/lib/i18n";
import { formatMoneyYuan } from "@/lib/format";
import { Printer, X } from "lucide-react";
import type { ReimbursementData } from "@/lib/server/sidebar-actions/reimbursement-actions";

// Print modals render into a body-level portal; when printing, every other body child
// (the whole app shell) is display:none so the sheets paginate on their own. The injected
// rules below override the modal chrome (fixed backdrop / panel caps) because Tailwind's
// print: variants can lose the cascade against custom classes like app-modal-backdrop.
//
// No @page size is emitted on purpose: locking @page would disable the paper size /
// orientation selectors in the browser print dialog's left panel. Sheets keep a fixed
// design width (277mm = A4 landscape minus default margins) so proportions and font
// sizes never change; when a narrower paper/orientation is picked in the dialog, the
// browser's default fit-to-width scaling shrinks the whole sheet proportionally.
const PRINT_PORTAL_RULES = `
  body > *:not([data-print-portal]) { display: none !important; }
  /* body carries h-screen (fixed viewport height) + an inline-style-free overflow lock
     while modals are open; a clamped/clipping root pins the whole print flow to the
     first page, so release both. */
  body { height: auto !important; overflow: visible !important; background: #fff !important; }
  [data-print-portal] {
    position: static !important;
    inset: auto !important;
    display: block !important;
    overflow: visible !important;
    height: auto !important;
    background: #fff !important;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  [data-print-portal] .app-modal-panel {
    position: static !important;
    display: block !important; /* flex containers never fragment; block layout is required for page breaks */
    max-height: none !important;
    width: 100% !important;
    max-width: none !important;
    height: auto !important;
    overflow: visible !important;
    border: 0 !important;
    box-shadow: none !important;
    resize: none !important;
  }
  [data-print-portal] .modal-header { display: none !important; }
  [data-print-portal] .print-scroll {
    max-height: none !important;
    overflow: visible !important;
    background: #fff !important;
    padding: 0 !important;
  }
  [data-print-portal] [data-print-sheet]:not(:last-child) { break-after: page; }
  [data-print-portal] .print-page {
    position: static !important;
    width: 277mm !important;
    min-height: 0 !important;
    max-width: none !important;
    padding: 0 !important;
    box-shadow: none !important;
  }
  [data-print-portal] [data-print-grip] { display: none !important; }
`;

// Interactive layout tweaks made in the preview before printing: dragged column
// widths (px, per table) and dragged row heights (px, per detail-table row index).
// Plain layout values, so they flow into window.print() unchanged. The batch print
// modal shares one adjustment object across all sheets so every form prints with
// the same grid.
export type ReimbursementPrintAdjust = {
  infoCols?: number[] | null;
  detailCols?: number[] | null;
  rowHeights?: Record<number, number> | null;
};

const INFO_COL_DEFAULTS = ["12%", "21.33%", "12%", "21.33%", "12%", "21.34%"];
const TRAVEL_COL_DEFAULTS = ["10%", "20%", "10%", "10%", "6%", "10%", "10%", "12%", "12%"];
const SIMPLE_COL_DEFAULTS = ["14%", "28%", "20%", "38%"];

/** Shared pointer-drag helper: reports deltas from the initial press until release. */
function beginDrag(
  event: ReactPointerEvent<HTMLElement>,
  onMove: (dx: number, dy: number) => void,
) {
  event.preventDefault();
  const grip = event.currentTarget;
  const startX = event.clientX;
  const startY = event.clientY;
  grip.setPointerCapture(event.pointerId);
  const move = (e: PointerEvent) => onMove(e.clientX - startX, e.clientY - startY);
  const up = () => {
    grip.removeEventListener("pointermove", move);
    grip.removeEventListener("pointerup", up);
    grip.removeEventListener("pointercancel", up);
  };
  grip.addEventListener("pointermove", move);
  grip.addEventListener("pointerup", up);
  grip.addEventListener("pointercancel", up);
}

function money(value: number | null | undefined) {
  return value == null ? "-" : formatMoneyYuan(value);
}

const thCell = "relative border border-slate-500 bg-slate-100 px-2 py-2 text-left font-medium";
const tdCell = "border border-slate-500 px-2 py-2";

/** One A4-landscape printable reimbursement sheet; shared by single preview and batch print. */
export function ReimbursementPrintArticle({
  reimbursement,
  counterpartyName,
  adjust = {},
  onAdjust,
}: {
  reimbursement: ReimbursementData;
  counterpartyName: string;
  adjust?: ReimbursementPrintAdjust;
  onAdjust?: (next: ReimbursementPrintAdjust) => void;
}) {
  const { t } = useI18n();
  const adjustRef = useRef(adjust);
  adjustRef.current = adjust;
  const isTravel = reimbursement.kind === "travel";
  const claimedTotal = reimbursement.totalAmount;
  const travelTotals = reimbursement.items.reduce((totals, item) => ({
    outside: totals.outside + (item.outsideTransportAmount ?? 0),
    city: totals.city + (item.cityTransportAmount ?? 0),
    subsidy: totals.subsidy + (item.subsidyAmount ?? 0),
    lodging: totals.lodging + (item.lodgingAmount ?? 0),
  }), { outside: 0, city: 0, subsidy: 0, lodging: 0 });
  const reportDate = reimbursement.createdAt.slice(0, 10);
  const blankRowCount = Math.max(0, 4 - reimbursement.items.length);
  const detailColumnCount = isTravel ? 9 : 4;
  const detailColDefaults = isTravel ? TRAVEL_COL_DEFAULTS : SIMPLE_COL_DEFAULTS;
  const rowHeightStyle = (rowIndex: number): CSSProperties | undefined => {
    const height = adjust.rowHeights?.[rowIndex];
    return height ? { height } : undefined;
  };

  // Column grips capture every column's on-screen px width at press time (the grip's
  // own row must map cells 1:1 to columns), then grow the grabbed column while the
  // others keep their px; table-fixed renormalizes proportions to fill the sheet width.
  const beginColDrag = (key: "infoCols" | "detailCols", index: number) =>
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!onAdjust) return;
      const row = event.currentTarget.closest("tr");
      if (!row) return;
      const colCount = key === "infoCols" ? 6 : detailColumnCount;
      const base = Array.from(row.children)
        .slice(0, colCount)
        .map((cell) => (cell as HTMLElement).getBoundingClientRect().width);
      beginDrag(event, (dx) => {
        const next = base.map((width, i) => (i === index ? Math.max(28, Math.round(width + dx)) : width));
        onAdjust({ ...adjustRef.current, [key]: next });
      });
    };

  const beginRowDrag = (rowIndex: number) => (event: ReactPointerEvent<HTMLElement>) => {
    if (!onAdjust) return;
    const row = event.currentTarget.closest("tr");
    if (!row) return;
    const startHeight = row.getBoundingClientRect().height;
    beginDrag(event, (dx, dy) => {
      const height = Math.max(28, Math.round(startHeight + dy));
      onAdjust({
        ...adjustRef.current,
        rowHeights: { ...adjustRef.current.rowHeights, [rowIndex]: height },
      });
    });
  };

  /** Drag handle on a cell's right edge; hidden in print via the injected rules. */
  const colGrip = (key: "infoCols" | "detailCols", index: number): ReactNode =>
    onAdjust ? (
      <span
        data-print-grip
        onPointerDown={beginColDrag(key, index)}
        className="absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize hover:bg-sky-400/50"
        title={t("reimburse.print.colResize")}
      />
    ) : null;

  /** Drag handle on a row's bottom edge (first cell only). */
  const rowGrip = (rowIndex: number): ReactNode =>
    onAdjust ? (
      <span
        data-print-grip
        onPointerDown={beginRowDrag(rowIndex)}
        className="absolute inset-x-0 bottom-0 z-10 h-1.5 cursor-row-resize hover:bg-sky-400/50"
        title={t("reimburse.print.rowResize")}
      />
    ) : null;

  return (
    <article className="print-page mx-auto min-h-[210mm] w-full max-w-[297mm] bg-white p-8 text-slate-900 print:min-h-0 print:max-w-none print:p-0">
      <h1 className="border-b-2 border-slate-800 pb-3 text-center text-xl font-bold">
        {t(`reimburse.print.title.${reimbursement.kind}`)}
      </h1>

      <table className="print-table mt-3 w-full table-fixed border-collapse text-xs">
        <colgroup>
          {(adjust.infoCols ?? INFO_COL_DEFAULTS).map((width, index) => (
            <col key={index} style={{ width }} />
          ))}
        </colgroup>
        <tbody>
          {/* First row maps cells 1:1 to the 6 columns, so it hosts the column grips. */}
          <tr>
            <th className={thCell}>{t("reimburse.document.number")}{colGrip("infoCols", 0)}</th>
            <td className={tdCell}>{reimbursement.documentNumber || reimbursement.title || ""}</td>
            <th className={thCell}>{t("reimburse.document.submittedDate")}{colGrip("infoCols", 2)}</th>
            <td className={tdCell}>{reportDate}</td>
            <th className={thCell}>{t("reimburse.form.attachmentCount")}{colGrip("infoCols", 4)}</th>
            <td className={tdCell}>{reimbursement.attachmentCount ?? 0}</td>
          </tr>
          {isTravel ? (
            <tr>
              <th className={thCell}>{t("reimburse.form.travelDateRange")}</th>
              <td colSpan={2} className={tdCell}>{reimbursement.travelStartDate || ""} ~ {reimbursement.travelEndDate || ""}</td>
              <th className={thCell}>{t("reimburse.form.travelReason")}</th>
              <td colSpan={2} className={tdCell}>{reimbursement.travelReason || ""}</td>
            </tr>
          ) : (
            <tr>
              <th className={thCell}>{t("reimburse.objectLabel")}</th>
              <td colSpan={5} className={tdCell}>{counterpartyName}</td>
            </tr>
          )}
        </tbody>
      </table>

      <table className="print-table mt-3 w-full table-fixed border-collapse text-xs">
        <colgroup>
          {(adjust.detailCols ?? detailColDefaults).map((width, index) => (
            <col key={index} style={{ width }} />
          ))}
        </colgroup>
        <thead>
          <tr className="bg-slate-100">
            {(isTravel
              ? ["reimburse.colDate", "reimburse.travel.routeVehicle", "reimburse.travel.outsideTransport", "reimburse.travel.cityTransport", "reimburse.travel.days", "reimburse.travel.allowance", "reimburse.expenseItem.lodging", "reimburse.editor.subtotal", "reimburse.colNote"]
              : ["reimburse.colDate", reimbursement.kind === "general" ? "reimburse.form.generalReason" : "reimburse.colCategory", "reimburse.colAmount", "reimburse.colNote"]
            ).map((key, index, all) => (
              <th key={key} className="relative border border-slate-500 px-1.5 py-2 text-center font-medium">
                {t(key)}
                {index < all.length - 1 ? colGrip("detailCols", index) : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {reimbursement.items.map((item, rowIndex) => isTravel ? (
            <tr key={item.id} style={rowHeightStyle(rowIndex)}>
              <td className="relative border border-slate-500 px-1.5 py-2 text-center tabular-nums">
                {item.entryDate}
                {rowGrip(rowIndex)}
              </td>
              <td className="border border-slate-500 px-1.5 py-2">{[item.fromPlace, item.toPlace].filter(Boolean).join(" → ") || "-"}</td>
              <td className="border border-slate-500 px-1.5 py-2 text-right tabular-nums">{money(item.outsideTransportAmount)}</td>
              <td className="border border-slate-500 px-1.5 py-2 text-right tabular-nums">{money(item.cityTransportAmount)}</td>
              <td className="border border-slate-500 px-1.5 py-2 text-right tabular-nums">{item.days ?? "-"}</td>
              <td className="border border-slate-500 px-1.5 py-2 text-right tabular-nums">{money(item.subsidyAmount)}</td>
              <td className="border border-slate-500 px-1.5 py-2 text-right tabular-nums">{money(item.lodgingAmount)}</td>
              <td className="border border-slate-500 px-1.5 py-2 text-right font-medium tabular-nums">{formatMoneyYuan(item.amount)}</td>
              <td className="border border-slate-500 px-1.5 py-2">{item.note || "-"}</td>
            </tr>
          ) : (
            <tr key={item.id} style={rowHeightStyle(rowIndex)}>
              <td className="relative border border-slate-500 px-2 py-2 text-center tabular-nums">
                {item.entryDate}
                {rowGrip(rowIndex)}
              </td>
              <td className="border border-slate-500 px-2 py-2">{item.categoryName || (item.expenseItem ? t(`reimburse.expenseItem.${item.expenseItem}`) : "-")}</td>
              <td className="border border-slate-500 px-2 py-2 text-right tabular-nums">{formatMoneyYuan(item.amount)}</td>
              <td className="border border-slate-500 px-2 py-2">{item.note || "-"}</td>
            </tr>
          ))}
          {Array.from({ length: blankRowCount }, (_, blankIndex) => {
            const rowIndex = reimbursement.items.length + blankIndex;
            return (
              <tr key={`blank-${blankIndex}`} style={rowHeightStyle(rowIndex)}>
                {Array.from({ length: detailColumnCount }, (_, cellIndex) => (
                  <td key={cellIndex} className={`h-8 border border-slate-500 px-1.5 py-2${cellIndex === 0 ? " relative" : ""}`}>
                    {cellIndex === 0 ? (
                      <>
                        &nbsp;
                        {rowGrip(rowIndex)}
                      </>
                    ) : "\u00A0"}
                  </td>
                ))}
              </tr>
            );
          })}
          {isTravel ? (
            <tr className="bg-slate-50 font-semibold">
              <td colSpan={2} className="border border-slate-500 px-2 py-2 text-right">{t("reimburse.totalLabel")}</td>
              <td className="border border-slate-500 px-1.5 py-2 text-right tabular-nums">{formatMoneyYuan(travelTotals.outside)}</td>
              <td className="border border-slate-500 px-1.5 py-2 text-right tabular-nums">{formatMoneyYuan(travelTotals.city)}</td>
              <td className="border border-slate-500 px-1.5 py-2 text-right tabular-nums">-</td>
              <td className="border border-slate-500 px-1.5 py-2 text-right tabular-nums">{formatMoneyYuan(travelTotals.subsidy)}</td>
              <td className="border border-slate-500 px-1.5 py-2 text-right tabular-nums">{formatMoneyYuan(travelTotals.lodging)}</td>
              <td className="border border-slate-500 px-1.5 py-2 text-right tabular-nums">{formatMoneyYuan(claimedTotal)}</td>
              <td className="border border-slate-500 px-1.5 py-2" />
            </tr>
          ) : (
            <tr className="bg-slate-50 font-semibold">
              <td colSpan={2} className="border border-slate-500 px-2 py-2 text-right">{t("reimburse.totalLabel")}</td>
              <td className="border border-slate-500 px-2 py-2 text-right tabular-nums">{formatMoneyYuan(claimedTotal)}</td>
              <td className="border border-slate-500 px-2 py-2" />
            </tr>
          )}
        </tbody>
      </table>

      <div className="mt-5 flex items-end justify-between gap-8 text-xs">
        <div className="min-w-56">{t("reimburse.print.departmentName")}：<span className="inline-block min-w-36 border-b border-slate-500">&nbsp;</span></div>
        {["reimburse.print.departmentSupervisor", "reimburse.print.office", "reimburse.print.finance"].map((key) => (
          <div key={key} className="flex flex-1 items-end whitespace-nowrap">
            {t(key)}：<span className="ml-1 inline-block h-5 min-w-12 flex-1 border-b border-slate-500">&nbsp;</span>
          </div>
        ))}
      </div>
    </article>
  );
}

function hasAdjustments(adjust: ReimbursementPrintAdjust) {
  return Boolean(
    adjust.infoCols?.length ||
    adjust.detailCols?.length ||
    (adjust.rowHeights && Object.keys(adjust.rowHeights).length > 0),
  );
}

/** Batch print preview: stacks one printable sheet per selected document, one page break between sheets. */
export function ReimbursementBatchPrintModal({
  reimbursements,
  counterpartyNameFallback,
  onClose,
}: {
  reimbursements: ReimbursementData[];
  counterpartyNameFallback: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [adjust, setAdjust] = useState<ReimbursementPrintAdjust>({});
  return createPortal(
    <div data-print-portal className="print-batch-root app-modal-backdrop z-[90] print:static print:block print:bg-white">
      <div className="app-modal-panel resize max-h-[95vh] w-[95vw] max-w-6xl print:block print:max-h-none print:w-full print:max-w-none print:resize-none print:border-0 print:shadow-none">
        <div className="modal-header shrink-0 border-b border-slate-200 print:hidden">
          <span className="text-sm font-semibold text-slate-800">{t("reimburse.batchPrint.title", { count: reimbursements.length })}</span>
          <div className="flex items-center gap-2">
            {hasAdjustments(adjust) ? (
              <button type="button" onClick={() => setAdjust({})} className="secondary-button flex h-8 items-center px-2 text-xs">
                {t("reimburse.print.resetSize")}
              </button>
            ) : null}
            <button type="button" onClick={() => window.print()} className="primary-button flex h-8 items-center gap-1.5 px-2.5" title={t("reimburse.print")}>
              <Printer className="h-4 w-4" />{t("reimburse.print")}
            </button>
            <button type="button" onClick={onClose} className="secondary-button flex h-8 w-8 items-center justify-center p-0" title={t("table.close")}>
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="print-scroll max-h-[calc(95vh-3.5rem)] overflow-auto bg-slate-100 p-4">
          {reimbursements.map((reimbursement, mapIndex) => (
            <div key={reimbursement.id} data-print-sheet className={mapIndex < reimbursements.length - 1 ? "print:break-after-page" : undefined}>
              <ReimbursementPrintArticle
                reimbursement={reimbursement}
                counterpartyName={reimbursement.advanceAccountName ?? counterpartyNameFallback}
                adjust={adjust}
                onAdjust={setAdjust}
              />
            </div>
          ))}
        </div>
      </div>
      <style>{`@media print { ${PRINT_PORTAL_RULES} }`}</style>
    </div>,
    document.body,
  );
}

export function ReimbursementPreview({
  reimbursement,
  counterpartyName,
  onClose,
}: {
  reimbursement: ReimbursementData;
  counterpartyName: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [adjust, setAdjust] = useState<ReimbursementPrintAdjust>({});

  return createPortal(
    <div data-print-portal className="app-modal-backdrop z-[90] print:static print:block print:bg-white">
      <div className="app-modal-panel resize max-h-[95vh] w-[95vw] max-w-6xl print:block print:max-h-none print:w-full print:max-w-none print:resize-none print:border-0 print:shadow-none">
        <div className="modal-header shrink-0 border-b border-slate-200 print:hidden">
          <span className="text-sm font-semibold text-slate-800">{t("reimburse.preview")}</span>
          <div className="flex items-center gap-2">
            {hasAdjustments(adjust) ? (
              <button type="button" onClick={() => setAdjust({})} className="secondary-button flex h-8 items-center px-2 text-xs">
                {t("reimburse.print.resetSize")}
              </button>
            ) : null}
            <button type="button" onClick={() => window.print()} className="primary-button flex h-8 items-center gap-1.5 px-2.5" title={t("reimburse.print")}>
              <Printer className="h-4 w-4" />{t("reimburse.print")}
            </button>
            <button type="button" onClick={onClose} className="secondary-button flex h-8 w-8 items-center justify-center p-0" title={t("table.close")}>
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="print-scroll max-h-[calc(95vh-3.5rem)] overflow-auto bg-slate-100 p-4">
          <ReimbursementPrintArticle
            reimbursement={reimbursement}
            counterpartyName={counterpartyName}
            adjust={adjust}
            onAdjust={setAdjust}
          />
        </div>
      </div>
      <style>{`@media print { ${PRINT_PORTAL_RULES} }`}</style>
    </div>,
    document.body,
  );
}
