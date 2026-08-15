import Link from "next/link";

import { SettingsCatalogIcon } from "@/components/settings/SettingsCatalogIcon";
import { getSettingsCatalogForSurface } from "@/lib/settings/catalog";
import { getServerT } from "@/lib/server/i18n";

export default async function SettingsPage() {
  const t = await getServerT();
  const catalog = getSettingsCatalogForSurface("web");

  return (
    <div className="mx-auto max-w-4xl space-y-3 md:space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white px-4 py-4">
        <h2 className="text-sm font-semibold text-slate-800">{catalog.title}</h2>
        <p className="mt-1 text-xs text-slate-500">
          {t("settings.catalogDescription")}
        </p>
      </div>

      {catalog.groups.map((group) => (
        <section key={group.id} className="space-y-2">
          <div className="px-1">
            <h3 className="text-xs font-semibold text-slate-700">{group.label}</h3>
            <p className="mt-0.5 text-[11px] text-slate-500">{group.description}</p>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {group.items.map((item) => {
              if (!item.webHref) return null;
              return (
                <Link
                  key={item.id}
                  href={item.webHref}
                  prefetch={false}
                  className="group rounded-xl border border-slate-200 bg-white px-4 py-3 transition-colors hover:border-blue-200 hover:bg-blue-50/40"
                >
                  <div className="flex items-center gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500 transition-colors group-hover:bg-blue-100 group-hover:text-blue-600">
                      <SettingsCatalogIcon icon={item.icon} className="h-4 w-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-slate-800">{item.label}</span>
                      <span className="mt-0.5 block truncate text-xs text-slate-500">{item.description}</span>
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
