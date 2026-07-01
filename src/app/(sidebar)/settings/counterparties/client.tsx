"use client";

import { useCallback, useEffect, useState } from "react";

import { CounterpartyEditButton } from "@/components/CounterpartyEditButton";
import { EntityCreateForm } from "@/components/EntityCreateForm";
import { SettingsDeleteButton } from "@/components/SettingsDeleteButton";
import { fetchSettingsAccountData, invalidateSettingsAccountData } from "@/lib/client/settingsCache";

type Counterparty = {
  id: string;
  name: string;
  shortName?: string | null;
  type: string | null;
};

const typeLabelMap: Record<string, string> = {
  family_member: "家庭成员",
  person: "个人",
  organization: "机构",
  company: "公司",
  friend: "朋友",
  other: "其他",
};

export function SettingsCounterpartiesClient({
  counterparties: initialCounterparties,
  updateAction,
}: {
  counterparties: Counterparty[];
  updateAction: (formData: FormData) => void | Promise<void>;
}) {
  const [counterparties, setCounterparties] = useState<Counterparty[]>(initialCounterparties);

  useEffect(() => {
    setCounterparties(initialCounterparties);
  }, [initialCounterparties]);

  const refreshList = useCallback(async () => {
    const data = await fetchSettingsAccountData({ force: true }).catch(() => null);
    if (data?.counterparties) setCounterparties(data.counterparties as Counterparty[]);
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
        entityType="counterparty"
        onCreated={handleCreated}
        existingNames={counterparties.map((item) => item.name)}
      />

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div>
            <div className="text-sm font-semibold text-slate-800">往来对象列表</div>
            <div className="mt-0.5 text-xs text-slate-500">用于往来款账户和代付对象</div>
          </div>
          <div className="tabular-nums text-xs text-slate-500">{counterparties.length} 项</div>
        </div>
        <div className="overflow-auto">
          <table className="w-full min-w-[760px] border-separate border-spacing-0">
            <thead className="sticky top-0 z-10">
              <tr className="bg-slate-50">
                <th className="border-b border-slate-200 px-4 py-2 text-left text-xs font-semibold text-slate-600">名称</th>
                <th className="border-b border-slate-200 px-3 py-2 text-left text-xs font-semibold text-slate-600">简称</th>
                <th className="border-b border-slate-200 px-3 py-2 text-left text-xs font-semibold text-slate-600">类型</th>
                <th className="border-b border-slate-200 px-3 py-2 text-left text-xs font-semibold text-slate-600">操作</th>
              </tr>
            </thead>
            <tbody className="text-sm">
              {counterparties.length ? counterparties.map((item) => (
                <tr key={item.id} className="hover:bg-slate-50">
                  <td className="border-b border-slate-100 px-4 py-2 text-sm text-slate-800">{item.name}</td>
                  <td className="border-b border-slate-100 px-3 py-2 text-sm text-slate-600">{item.shortName?.trim() || "-"}</td>
                  <td className="border-b border-slate-100 px-3 py-2 text-xs text-slate-500">{typeLabelMap[item.type ?? "other"] ?? item.type}</td>
                  <td className="border-b border-slate-100 px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      <CounterpartyEditButton counterparty={item} action={updateAction} />
                      <SettingsDeleteButton label={`往来对象：${item.name}`} entity="counterparty" id={item.id} />
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
