"use client";

import { useState, useCallback } from "react";
import { EntityCreateForm } from "@/components/EntityCreateForm";
import { InstitutionEditButton } from "@/components/InstitutionEditButton";
import { SettingsDeleteButton } from "@/components/SettingsDeleteButton";
import { fetchSettingsAccountData, invalidateSettingsAccountData } from "@/lib/client/settingsCache";

type Institution = {
  id: string;
  name: string;
  type: string | null;
};

const typeLabelMap: Record<string, string> = {
  bank: "银行",
  brokerage: "证券",
  payment: "三方支付",
  ewallet: "钱包",
  other: "其他",
};

export function SettingsInstitutionsClient({
  institutions: initialInstitutions,
  updateAction,
}: {
  institutions: Institution[];
  updateAction: (formData: FormData) => void | Promise<void>;
}) {
  const [institutions, setInstitutions] = useState<Institution[]>(initialInstitutions);

  const refreshList = useCallback(async () => {
    const data = await fetchSettingsAccountData({ force: true }).catch(() => null);
    if (data?.institutions) setInstitutions(data.institutions as Institution[]);
  }, []);

  function handleCreated(id: string, name: string) {
    // Refresh the list to include the new institution with its proper type
    invalidateSettingsAccountData();
    refreshList();
  }

  function handleDelete(id: string) {
    setInstitutions(prev => prev.filter(i => i.id !== id));
  }

  return (
    <div className="space-y-4">
      {/* 新增机构 */}
      <EntityCreateForm
        mode="full" layout="inline" entityType="institution"
        onCreated={handleCreated}
        existingNames={institutions.map(i => i.name)}
      />

      {/* 机构列表 */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
          <div className="text-sm font-semibold text-slate-800">机构列表</div>
          <div className="text-xs text-slate-500 tabular-nums">{institutions.length} 个</div>
        </div>
        <div className="overflow-auto">
          <table className="min-w-[780px] w-full border-separate border-spacing-0">
            <thead className="sticky top-0 z-10">
              <tr className="bg-slate-50">
                <th className="text-left text-xs font-semibold text-slate-600 px-4 py-2 border-b border-slate-200">名称</th>
                <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">类型</th>
                <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">操作</th>
              </tr>
            </thead>
            <tbody className="text-sm">
              {institutions.length ? (
                institutions.map((it) => (
                  <tr key={it.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2 border-b border-slate-100 text-sm text-slate-800">{it.name}</td>
                    <td className="px-3 py-2 border-b border-slate-100 text-xs text-slate-500">
                      {typeLabelMap[it.type ?? "other"] ?? it.type}
                    </td>
                    <td className="px-3 py-2 border-b border-slate-100">
                      <div className="flex items-center gap-1.5">
                        <InstitutionEditButton institution={it} action={updateAction} />
                        <SettingsDeleteButton label={`机构：${it.name}`} entity="institution" id={it.id} />
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="px-4 py-6 text-slate-500" colSpan={3}>暂无机构</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
