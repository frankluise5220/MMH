import Link from "next/link";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db/prisma";
import { SettingsDeleteButton } from "@/components/SettingsDeleteButton";
import { InstitutionEditButton } from "@/components/InstitutionEditButton";

export const dynamic = "force-dynamic";

async function createInstitution(formData: FormData) {
  "use server";

  const name = String(formData.get("institutionName") ?? "").trim();
  const type = String(formData.get("institutionType") ?? "").trim();
  if (!name) return;

  await prisma.institution
    .create({
      data: { name, type: type || null },
    })
    .catch(() => null);

  revalidatePath("/settings/institutions");
  revalidatePath("/settings/accounts");
  revalidatePath("/accounts");
}

async function updateInstitutionRow(formData: FormData) {
  "use server";

  const institutionId = String(formData.get("institutionId") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const type = String(formData.get("type") ?? "").trim();
  if (!institutionId || !name) return;

  await prisma.institution
    .update({
      where: { id: institutionId },
      data: { name, type: type || null },
    })
    .catch(() => null);

  revalidatePath("/settings/institutions");
  revalidatePath("/settings/accounts");
  revalidatePath("/accounts");
}

export default async function SettingsInstitutionsPage() {
  const institutions = await prisma.institution.findMany({ orderBy: [{ type: "asc" }, { name: "asc" }] });

  return (
    <div className="space-y-4">
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
            <div className="text-sm font-semibold text-slate-800">新增机构</div>
          </div>
          <div className="p-4">
            <form action={createInstitution} className="grid grid-cols-1 md:grid-cols-3 gap-2">
              <input
                name="institutionName"
                className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                placeholder="机构名称，例如：招行 / 支付宝 / 中信证券"
              />
              <select
                name="institutionType"
                className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                defaultValue="bank"
              >
                <option value="bank">银行</option>
                <option value="brokerage">证券</option>
                <option value="payment">三方支付</option>
                <option value="ewallet">钱包</option>
                <option value="other">其他</option>
              </select>
              <button className="h-9 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700">新增</button>
            </form>
          </div>
        </div>

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
                        {{ bank: "银行", brokerage: "证券", payment: "三方支付", ewallet: "钱包", other: "其他" }[it.type ?? "other"] ?? it.type}
                      </td>
                      <td className="px-3 py-2 border-b border-slate-100">
                        <div className="flex items-center gap-1.5">
                          <InstitutionEditButton institution={it} action={updateInstitutionRow} />
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
