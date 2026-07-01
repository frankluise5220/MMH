"use client";

import { useState, useCallback, useEffect } from "react";

import { EntityCreateForm } from "@/components/EntityCreateForm";
import { InstitutionEditButton } from "@/components/InstitutionEditButton";
import { SettingsDeleteButton } from "@/components/SettingsDeleteButton";
import { fetchSettingsAccountData, invalidateSettingsAccountData } from "@/lib/client/settingsCache";

type Institution = {
  id: string;
  name: string;
  shortName?: string | null;
  type: string | null;
};

const typeLabelMap: Record<string, string> = {
  family_member: "家庭成员",
  person: "往来人员",
  organization: "往来机构",
  bank: "银行",
  insurance: "保险公司",
  brokerage: "证券",
  payment: "第三方支付",
  ewallet: "钱包",
  debt: "债权债务",
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

  useEffect(() => {
    setInstitutions(initialInstitutions);
  }, [initialInstitutions]);

  const refreshList = useCallback(async () => {
    const data = await fetchSettingsAccountData({ force: true }).catch(() => null);
    if (data?.institutions) setInstitutions(data.institutions as Institution[]);
  }, []);

  function handleCreated() {
    invalidateSettingsAccountData();
    refreshList();
  }

  return (
    <div className="space-y-4">
      <EntityCreateForm
        mode="full"
        layout="inline"
        entityType="institution"
        onCreated={handleCreated}
        existingNames={institutions.map((item) => item.name)}
      />

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div className="text-sm font-semibold text-slate-800">往来对象列表</div>
          <div className="tabular-nums text-xs text-slate-500">{institutions.length} 项</div>
        </div>
        <div className="overflow-auto">
          <table className="min-w-[780px] w-full border-separate border-spacing-0">
            <thead className="sticky top-0 z-10">
              <tr className="bg-slate-50">
                <th className="border-b border-slate-200 px-4 py-2 text-left text-xs font-semibold text-slate-600">名称</th>
                <th className="border-b border-slate-200 px-3 py-2 text-left text-xs font-semibold text-slate-600">简称</th>
                <th className="border-b border-slate-200 px-3 py-2 text-left text-xs font-semibold text-slate-600">类型</th>
                <th className="border-b border-slate-200 px-3 py-2 text-left text-xs font-semibold text-slate-600">操作</th>
              </tr>
            </thead>
            <tbody className="text-sm">
              {institutions.length ? institutions.map((item) => (
                <tr key={item.id} className="hover:bg-slate-50">
                  <td className="border-b border-slate-100 px-4 py-2 text-sm text-slate-800">{item.name}</td>
                  <td className="border-b border-slate-100 px-3 py-2 text-sm text-slate-600">{item.shortName?.trim() || "-"}</td>
                  <td className="border-b border-slate-100 px-3 py-2 text-xs text-slate-500">{typeLabelMap[item.type ?? "other"] ?? item.type}</td>
                  <td className="border-b border-slate-100 px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      <InstitutionEditButton institution={item} action={updateAction} />
                      <SettingsDeleteButton label={`往来对象：${item.name}`} entity="institution" id={item.id} />
                    </div>
                  </td>
                </tr>
              )) : (
                <tr>
                  <td className="px-4 py-6 text-slate-500" colSpan={4}>暂无往来对象</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
