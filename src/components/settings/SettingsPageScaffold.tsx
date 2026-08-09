"use client";

import { Plus } from "lucide-react";

export function SettingsPageHeader({
  title,
  description,
  count,
  actions,
  toolbar,
  sticky = false,
}: {
  title: string;
  description?: string;
  count?: number | string;
  actions?: React.ReactNode;
  toolbar?: React.ReactNode;
  sticky?: boolean;
}) {
  return (
    <div className={sticky ? "sticky top-0 z-20 border-b border-slate-200 bg-slate-50/95 pb-3 pt-1 backdrop-blur" : ""}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
            {count !== undefined ? (
              <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] tabular-nums text-slate-500">
                {count} 项
              </span>
            ) : null}
          </div>
          {description ? <p className="mt-1 text-xs text-slate-500">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {toolbar ? <div className="mt-3 flex flex-wrap items-center gap-2">{toolbar}</div> : null}
    </div>
  );
}

export function SettingsPrimaryAddButton({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} className="primary-button h-9 shrink-0 gap-1.5">
      <Plus className="h-3.5 w-3.5" />
      {children}
    </button>
  );
}

export function SettingsSection({
  title,
  description,
  count,
  actions,
  children,
}: {
  title: string;
  description?: string;
  count?: number | string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="panel-surface overflow-hidden">
      <div className="panel-header gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="text-sm font-medium text-slate-800">{title}</div>
            {count !== undefined ? <span className="text-xs tabular-nums text-slate-400">({count})</span> : null}
          </div>
          {description ? <div className="mt-1 text-xs text-slate-500">{description}</div> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function SettingsTable({
  minWidth = 760,
  children,
}: {
  minWidth?: number;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-auto">
      <table className="w-full border-separate border-spacing-0" style={{ minWidth }}>
        {children}
      </table>
    </div>
  );
}

export function SettingsTh({
  children,
  align,
}: {
  children: React.ReactNode;
  align?: "right" | "center";
}) {
  return (
    <th
      className={[
        "border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-600",
        align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left",
      ].join(" ")}
    >
      {children}
    </th>
  );
}

export function SettingsTd({
  children,
  align,
  className,
}: {
  children: React.ReactNode;
  align?: "right" | "center";
  className?: string;
}) {
  return (
    <td
      className={[
        "border-b border-slate-100 px-3 py-2 text-xs text-slate-600",
        align === "right" ? "text-right tabular-nums" : align === "center" ? "text-center" : "text-left",
        className ?? "",
      ].join(" ")}
    >
      {children}
    </td>
  );
}

export function SettingsEmptyRow({ colSpan, children }: { colSpan: number; children: React.ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-10 text-center text-sm text-slate-400">
        {children}
      </td>
    </tr>
  );
}

export function SettingsRowActions({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center justify-end gap-1.5">{children}</div>;
}

export function SettingsPreferencePanel({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="panel-surface overflow-hidden">
      <div className="panel-header">
        <div>
          <div className="text-sm font-medium text-slate-800">{title}</div>
          {description ? <div className="mt-1 text-xs text-slate-500">{description}</div> : null}
        </div>
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}
