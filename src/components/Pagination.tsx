"use client";

import Link from "next/link";

type Props = {
  currentPage: number;
  totalPages: number;
  pageSize: number;
  pageSizes?: number[];
  hrefBase: (page: number, size: number) => string;
};

export function Pagination({ currentPage, totalPages, pageSize, pageSizes = [10, 20, 40], hrefBase }: Props) {
  return (
    <div className="flex items-center gap-2 text-xs">
      {pageSizes.map((n) => {
        const active = pageSize === n;
        return (
          <Link key={n} href={hrefBase(1, n)} className={`h-6 px-1.5 rounded border flex items-center ${active ? "border-blue-300 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}>
            {n}
          </Link>
        );
      })}
      <span className="text-slate-400">|</span>
      {currentPage > 1 ? (
        <Link href={hrefBase(1, pageSize)} className="h-6 px-1.5 rounded border border-slate-200 bg-white text-slate-500 hover:bg-slate-50" title="首页">&laquo;</Link>
      ) : null}
      {currentPage > 1 ? (
        <Link href={hrefBase(currentPage - 1, pageSize)} className="h-6 px-1.5 rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-50" title="上一页">&lt;</Link>
      ) : null}
      <span className="text-slate-600">{currentPage}/{totalPages}</span>
      {currentPage < totalPages ? (
        <Link href={hrefBase(currentPage + 1, pageSize)} className="h-6 px-1.5 rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-50" title="下一页">&gt;</Link>
      ) : null}
      {currentPage < totalPages ? (
        <Link href={hrefBase(totalPages, pageSize)} className="h-6 px-1.5 rounded border border-slate-200 bg-white text-slate-500 hover:bg-slate-50" title="末页">&raquo;</Link>
      ) : null}
    </div>
  );
}
