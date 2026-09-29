"use client";

import { createPortal } from "react-dom";
import { useI18n } from "@/lib/i18n";
import { formatMoneyYuan } from "@/lib/format";
import { Printer, X } from "lucide-react";
import type { ReimbursementData } from "@/lib/server/sidebar-actions/reimbursement-actions";

// Print modals render into a body-level portal; when printing, every other body child
// (the whole app shell) is display:none so the sheets paginate on their own. The injected
// rules below override the modal chrome (fixed backdrop / panel caps) because Tailwind's
// print: variants can lose the cascade against custom classes like app-modal-backdrop.
// The native browser print dialog (window.print) still offers printer / paper / duplex.
const PRINT_PORTAL_STYLE = `@media print {
  @page { size: A4 landscape; margin: 10mm; }
  body > *:not([data-print-portal]) { display: none !important; }
  body { background: #fff !important; }
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
    min-height: 0 !important;
    max-width: none !important;
    padding: 0 !important;
    box-shadow: none !important;
  }
}`;

function money(value: number | null | undefined) {
  return value == null ? "-" : formatMoneyYuan(value);
}

/** One A4-landscape printable reimbursement sheet; shared by single preview and batch print. */
export function ReimbursementPrintArticle({
  reimbursement,
  counterpartyName,
}: {
  reimbursement: ReimbursementData;
  counterpartyName: string;
}) {
  const { t } = useI18n();
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

  return (
    <article className="print-page mx-auto min-h-[210mm] w-full max-w-[297mm] bg-white p-8 text-slate-900 print:min-h-0 print:max-w-none print:p-0">
      <h1 className="border-b-2 border-slate-800 pb-3 text-center text-xl font-bold">
        {t(`reimburse.print.title.${reimbursement.kind}`)}
      </h1>

      <table className="print-table mt-3 w-full table-fixed border-collapse text-xs">
        <tbody>
          <tr>
            <th className="w-[12%] border border-slate-500 bg-slate-100 px-2 py-2 text-left font-medium">{t("reimburse.document.number")}</th>
            <td className="w-[21.33%] border border-slate-500 px-2 py-2">{reimbursement.documentNumber || reimbursement.title || ""}</td>
            <th className="w-[12%] border border-slate-500 bg-slate-100 px-2 py-2 text-left font-medium">{t("reimburse.document.submittedDate")}</th>
            <td className="w-[21.33%] border border-slate-500 px-2 py-2">{reportDate}</td>
            <th className="w-[12%] border border-slate-500 bg-slate-100 px-2 py-2 text-left font-medium">{t("reimburse.form.attachmentCount")}</th>
            <td className="w-[21.34%] border border-slate-500 px-2 py-2">{reimbursement.attachmentCount ?? 0}</td>
          </tr>
          {isTravel ? (
            <tr>
              <th className="w-[12%] border border-slate-500 bg-slate-100 px-2 py-2 text-left font-medium">{t("reimburse.form.travelDateRange")}</th>
              <td colSpan={2} className="border border-slate-500 px-2 py-2">{reimbursement.travelStartDate || ""} ~ {reimbursement.travelEndDate || ""}</td>
              <th className="w-[12%] border border-slate-500 bg-slate-100 px-2 py-2 text-left font-medium">{t("reimburse.form.travelReason")}</th>
              <td colSpan={2} className="border border-slate-500 px-2 py-2">{reimbursement.travelReason || ""}</td>
            </tr>
          ) : (
            <tr>
              <th className="w-[12%] border border-slate-500 bg-slate-100 px-2 py-2 text-left font-medium">{t("reimburse.objectLabel")}</th>
              <td colSpan={5} className="border border-slate-500 px-2 py-2">{counterpartyName}</td>
            </tr>
          )}
        </tbody>
      </table>

      <table className="print-table mt-3 w-full border-collapse text-xs">
        <thead>
          {isTravel ? (
            <tr className="bg-slate-100">
              {["reimburse.colDate", "reimburse.travel.routeVehicle", "reimburse.travel.outsideTransport", "reimburse.travel.cityTransport", "reimburse.travel.days", "reimburse.travel.allowance", "reimburse.expenseItem.lodging", "reimburse.editor.subtotal", "reimburse.colNote"].map((key) => (
                <th key={key} className="border border-slate-500 px-1.5 py-2 text-center font-medium">{t(key)}</th>
              ))}
            </tr>
          ) : (
            <tr className="bg-slate-100">
              {["reimburse.colDate", reimbursement.kind === "general" ? "reimburse.form.generalReason" : "reimburse.colCategory", "reimburse.colAmount", "reimburse.colNote"].map((key) => (
                <th key={key} className="border border-slate-500 px-2 py-2 text-center font-medium">{t(key)}</th>
              ))}
            </tr>
          )}
        </thead>
        <tbody>
          {reimbursement.items.map((item) => isTravel ? (
            <tr key={item.id}>
              <td className="border border-slate-500 px-1.5 py-2 text-center tabular-nums">{item.entryDate}</td>
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
            <tr key={item.id}>
              <td className="border border-slate-500 px-2 py-2 text-center tabular-nums">{item.entryDate}</td>
              <td className="border border-slate-500 px-2 py-2">{item.categoryName || (item.expenseItem ? t(`reimburse.expenseItem.${item.expenseItem}`) : "-")}</td>
              <td className="border border-slate-500 px-2 py-2 text-right tabular-nums">{formatMoneyYuan(item.amount)}</td>
              <td className="border border-slate-500 px-2 py-2">{item.note || "-"}</td>
            </tr>
          ))}
          {Array.from({ length: blankRowCount }, (_, index) => (
            <tr key={`blank-${index}`}>
              {Array.from({ length: detailColumnCount }, (_, cellIndex) => <td key={cellIndex} className="h-8 border border-slate-500 px-1.5 py-2">&nbsp;</td>)}
            </tr>
          ))}
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
  return createPortal(
    <div data-print-portal className="print-batch-root app-modal-backdrop z-[90] print:static print:block print:bg-white">
      <div className="app-modal-panel resize max-h-[95vh] w-[95vw] max-w-6xl print:block print:max-h-none print:w-full print:max-w-none print:resize-none print:border-0 print:shadow-none">
        <div className="modal-header shrink-0 border-b border-slate-200 print:hidden">
          <span className="text-sm font-semibold text-slate-800">{t("reimburse.batchPrint.title", { count: reimbursements.length })}</span>
          <div className="flex items-center gap-2">
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
              />
            </div>
          ))}
        </div>
      </div>
      <style>{PRINT_PORTAL_STYLE}</style>
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

  return createPortal(
    <div data-print-portal className="app-modal-backdrop z-[90] print:static print:block print:bg-white">
      <div className="app-modal-panel resize max-h-[95vh] w-[95vw] max-w-6xl print:block print:max-h-none print:w-full print:max-w-none print:resize-none print:border-0 print:shadow-none">
        <div className="modal-header shrink-0 border-b border-slate-200 print:hidden">
          <span className="text-sm font-semibold text-slate-800">{t("reimburse.preview")}</span>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => window.print()} className="primary-button flex h-8 items-center gap-1.5 px-2.5" title={t("reimburse.print")}>
              <Printer className="h-4 w-4" />{t("reimburse.print")}
            </button>
            <button type="button" onClick={onClose} className="secondary-button flex h-8 w-8 items-center justify-center p-0" title={t("table.close")}>
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="print-scroll max-h-[calc(95vh-3.5rem)] overflow-auto bg-slate-100 p-4">
          <ReimbursementPrintArticle reimbursement={reimbursement} counterpartyName={counterpartyName} />
        </div>
      </div>
      <style>{PRINT_PORTAL_STYLE}</style>
    </div>,
    document.body,
  );
}
