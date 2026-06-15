"use client";

import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  LineChart, Line,
  PieChart, Pie, Cell,
  ComposedChart,
} from "recharts";
import { formatMoney } from "@/lib/format";

const COLORS = {
  income: "#10b981",
  expense: "#f43f5e",
  investPnL: "#8b5cf6",
  net: "#3b82f6",
  cumNet: "#06b6d4",
};
const PIE_COLORS = ["#10b981", "#3b82f6", "#f59e0b", "#8b5cf6", "#ec4899", "#06b6d4", "#f43f5e", "#84cc16"];

type MonthData = {
  month: string;
  income: number;
  expense: number;
  investPnL: number;
  netTotal: number;
  cumNet: number;
};

type CategoryData = {
  name: string;
  value: number;
  pct: number;
};

type TagGroupData = {
  id: string;
  name: string;
  color: string;
  value: number;
  pct: number;
};

type PnLItem = {
  id: string;
  date: string;
  fundCode: string;
  fundName: string;
  subtype: string;
  amount: number;
  profit: number;
  profitRate: number;
};

type Props = {
  monthData: MonthData[];
  incomeCats: CategoryData[];
  expenseCats: CategoryData[];
  incomeTagGroups: TagGroupData[];
  expenseTagGroups: TagGroupData[];
  pnlList: PnLItem[];
  isRedUp: boolean;
};

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border border-slate-200 rounded-lg shadow-lg p-3 text-xs">
      <div className="font-medium text-slate-700 mb-1">{label}</div>
      {payload.map((p: any, i: number) => (
        <div key={i} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ background: p.color }} />
          <span className="text-slate-500">{p.name}:</span>
          <span className="tabular-nums font-medium">{formatMoney(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

function renderPieLabel({ name, percent }: { name?: string; percent?: number }) {
  if (!name || !percent || percent < 0.05) return "";
  return `${name} ${(percent * 100).toFixed(1)}%`;
}

export default function StatisticsCharts({ monthData, incomeCats, expenseCats, incomeTagGroups, expenseTagGroups, pnlList, isRedUp }: Props) {
  const upCls = isRedUp ? "text-red-600" : "text-emerald-700";
  const downCls = isRedUp ? "text-emerald-700" : "text-red-600";
  const pnlCls = (n: number) => n > 0 ? upCls : n < 0 ? downCls : "text-slate-600";
  const pnlClsText = isRedUp ? "text-red-600" : "text-emerald-700";
  const lossClsText = isRedUp ? "text-emerald-700" : "text-red-600";

  const totalIncome = monthData.reduce((s, m) => s + m.income, 0);
  const totalExpense = monthData.reduce((s, m) => s + m.expense, 0);
  const totalInvestPnL = monthData.reduce((s, m) => s + m.investPnL, 0);
  const totalNet = totalIncome - totalExpense + totalInvestPnL;

  return (
    <div className="space-y-6">
      {/* ===== 汇总卡片 ===== */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "总收入", value: totalIncome, cls: "text-emerald-600" },
          { label: "总支出", value: -totalExpense, cls: "text-rose-600" },
          { label: "净收支", value: totalIncome - totalExpense, cls: pnlCls(totalIncome - totalExpense) },
          { label: "投资盈亏", value: totalInvestPnL, cls: pnlCls(totalInvestPnL) },
          { label: "综合盈亏", value: totalNet, cls: pnlCls(totalNet) },
        ].map((c) => (
          <div key={c.label} className="bg-white border border-slate-200 rounded-xl p-4">
            <div className="text-[11px] text-slate-500 mb-1">{c.label}</div>
            <div className={`text-lg font-bold tabular-nums ${c.cls}`}>
              {c.value >= 0 && c.label !== "总支出" ? "+" : ""}{formatMoney(c.value)}
            </div>
          </div>
        ))}
      </div>

      {/* ===== 图表行: 月度收支柱状图 + 累计净值曲线 ===== */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* 月度收支柱状图 */}
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
            <div className="text-sm font-semibold text-slate-800">月度收支</div>
          </div>
          <div className="p-3">
            {monthData.length === 0 ? (
              <div className="h-64 flex items-center justify-center text-xs text-slate-400">暂无数据</div>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={monthData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#64748b" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: "#64748b" }} axisLine={false} tickLine={false} tickFormatter={(v) => (v >= 10000 ? `${(v / 10000).toFixed(1)}万` : v)} />
                  <Tooltip content={<CustomTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="income" name="收入" fill={COLORS.income} radius={[3, 3, 0, 0]} barSize={16} />
                  <Bar dataKey="expense" name="支出" fill={COLORS.expense} radius={[3, 3, 0, 0]} barSize={16} />
                  <Line type="monotone" dataKey="netTotal" name="综合盈亏" stroke={COLORS.net} strokeWidth={2} dot={{ r: 3 }} />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* 累计净资产曲线 */}
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
            <div className="text-sm font-semibold text-slate-800">累计净值趋势</div>
          </div>
          <div className="p-3">
            {monthData.length === 0 ? (
              <div className="h-64 flex items-center justify-center text-xs text-slate-400">暂无数据</div>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={monthData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#64748b" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: "#64748b" }} axisLine={false} tickLine={false} tickFormatter={(v) => (v >= 10000 ? `${(v / 10000).toFixed(1)}万` : v)} />
                  <Tooltip content={<CustomTooltip />} />
                  <defs>
                    <linearGradient id="cumNetGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={COLORS.cumNet} stopOpacity={0.2} />
                      <stop offset="95%" stopColor={COLORS.cumNet} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <Line type="monotone" dataKey="cumNet" name="累计净值" stroke={COLORS.cumNet} strokeWidth={2.5} dot={{ r: 3, fill: COLORS.cumNet }} fill="url(#cumNetGrad)" />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>

      {/* ===== 饼图行：收入来源 + 支出分类 ===== */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* 收入饼图 */}
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
            <div className="text-sm font-semibold text-slate-800">收入来源</div>
          </div>
          <div className="p-3">
            {incomeCats.length === 0 ? (
              <div className="h-64 flex items-center justify-center text-xs text-slate-400">暂无收入数据</div>
            ) : (
              <div className="flex items-center">
                <ResponsiveContainer width="55%" height={240}>
                  <PieChart>
                    <Pie data={incomeCats} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={45} outerRadius={80} paddingAngle={2} label={renderPieLabel} labelLine={false}>
                      {incomeCats.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                    </Pie>
                    <Tooltip content={<CustomTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="flex-1 space-y-1.5">
                  {incomeCats.slice(0, 6).map((c, i) => (
                    <div key={c.name} className="flex items-center gap-1.5 text-xs">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                      <span className="text-slate-600 truncate flex-1">{c.name}</span>
                      <span className="tabular-nums text-slate-400">{c.pct.toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 支出饼图 */}
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
            <div className="text-sm font-semibold text-slate-800">支出分类</div>
          </div>
          <div className="p-3">
            {expenseCats.length === 0 ? (
              <div className="h-64 flex items-center justify-center text-xs text-slate-400">暂无支出数据</div>
            ) : (
              <div className="flex items-center">
                <ResponsiveContainer width="55%" height={240}>
                  <PieChart>
                    <Pie data={expenseCats} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={45} outerRadius={80} paddingAngle={2} label={renderPieLabel} labelLine={false}>
                      {expenseCats.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                    </Pie>
                    <Tooltip content={<CustomTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="flex-1 space-y-1.5">
                  {expenseCats.slice(0, 6).map((c, i) => (
                    <div key={c.name} className="flex items-center gap-1.5 text-xs">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                      <span className="text-slate-600 truncate flex-1">{c.name}</span>
                      <span className="tabular-nums text-slate-400">{c.pct.toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ===== 标签分组饼图（仅有标签数据时显示） ===== */}
      {(incomeTagGroups.length > 0 || expenseTagGroups.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* 收入标签饼图 */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
              <div className="text-sm font-semibold text-slate-800">收入标签分布</div>
            </div>
            <div className="p-3">
              {incomeTagGroups.length === 0 ? (
                <div className="h-64 flex items-center justify-center text-xs text-slate-400">暂无标签收入数据</div>
              ) : (
                <div className="flex items-center">
                  <ResponsiveContainer width="55%" height={240}>
                    <PieChart>
                      <Pie data={incomeTagGroups} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={45} outerRadius={80} paddingAngle={2} label={renderPieLabel} labelLine={false}>
                        {incomeTagGroups.map((t) => <Cell key={t.id} fill={t.color} />)}
                      </Pie>
                      <Tooltip content={<CustomTooltip />} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="flex-1 space-y-1.5">
                    {incomeTagGroups.slice(0, 6).map((t) => (
                      <div key={t.id} className="flex items-center gap-1.5 text-xs">
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: t.color }} />
                        <span className="text-slate-600 truncate flex-1">{t.name}</span>
                        <span className="tabular-nums text-slate-400">{t.pct.toFixed(1)}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* 支出标签饼图 */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
              <div className="text-sm font-semibold text-slate-800">支出标签分布</div>
            </div>
            <div className="p-3">
              {expenseTagGroups.length === 0 ? (
                <div className="h-64 flex items-center justify-center text-xs text-slate-400">暂无标签支出数据</div>
              ) : (
                <div className="flex items-center">
                  <ResponsiveContainer width="55%" height={240}>
                    <PieChart>
                      <Pie data={expenseTagGroups} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={45} outerRadius={80} paddingAngle={2} label={renderPieLabel} labelLine={false}>
                        {expenseTagGroups.map((t) => <Cell key={t.id} fill={t.color} />)}
                      </Pie>
                      <Tooltip content={<CustomTooltip />} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="flex-1 space-y-1.5">
                    {expenseTagGroups.slice(0, 6).map((t) => (
                      <div key={t.id} className="flex items-center gap-1.5 text-xs">
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: t.color }} />
                        <span className="text-slate-600 truncate flex-1">{t.name}</span>
                        <span className="tabular-nums text-slate-400">{t.pct.toFixed(1)}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ===== 盈氯列表 ===== */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
          <div className="text-sm font-semibold text-slate-800">投资盈亏明细</div>
          <div className="text-xs text-slate-500">{pnlList.length} 条</div>
        </div>
        {pnlList.length === 0 ? (
          <div className="px-4 py-8 text-xs text-slate-400 text-center">暂无已实现盈亏记录</div>
        ) : (
          <div className="overflow-x-auto max-h-[360px] overflow-y-auto">
            <table className="min-w-[600px] w-full border-separate border-spacing-0">
              <thead className="sticky top-0 bg-white z-10">
                <tr>
                  <th className="text-left text-xs font-semibold text-slate-600 px-4 py-2 border-b border-slate-200">日期</th>
                  <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">基金</th>
                  <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">类型</th>
                  <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">金额</th>
                  <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">盈亏</th>
                  <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">收益率</th>
                </tr>
              </thead>
              <tbody>
                {pnlList.map((e) => (
                  <tr key={e.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2 border-b border-slate-100 text-xs tabular-nums text-slate-600">{e.date}</td>
                    <td className="px-3 py-2 border-b border-slate-100 text-xs text-slate-700">
                      {e.fundName || e.fundCode}{e.fundName && e.fundCode && e.fundName !== e.fundCode && <span className="ml-1 text-slate-400">{e.fundCode}</span>}
                    </td>
                    <td className="px-3 py-2 border-b border-slate-100 text-xs">
                      <span className={`px-1 py-0.5 rounded text-[10px] font-medium ${
                        e.subtype === "dividend_cash" ? "bg-emerald-50 text-emerald-600"
                        : e.subtype === "redeem" ? "bg-orange-50 text-orange-600"
                        : "bg-amber-50 text-amber-600"
                      }`}>
                        {e.subtype === "dividend_cash" ? "现金红利" : e.subtype === "redeem" ? "赎回" : "转出"}
                      </span>
                    </td>
                    <td className="px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums text-slate-600">{formatMoney(Math.abs(e.amount))}</td>
                    <td className={`px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums font-medium ${e.profit >= 0 ? pnlClsText : lossClsText}`}>
                      {e.profit >= 0 ? "+" : ""}{formatMoney(e.profit)}
                    </td>
                    <td className={`px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums ${e.profit >= 0 ? pnlClsText : lossClsText}`}>
                      {e.profitRate !== 0 ? `${(e.profitRate * 100).toFixed(2)}%` : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="sticky bottom-0 bg-slate-50">
                <tr>
                  <td className="px-4 py-2 border-t border-slate-200 text-xs font-semibold text-slate-700" colSpan={4}>合计</td>
                  <td className={`px-3 py-2 border-t border-slate-200 text-right text-xs tabular-nums font-semibold ${pnlCls(pnlList.reduce((s, e) => s + e.profit, 0))}`}>
                    {(() => { const t = pnlList.reduce((s, e) => s + e.profit, 0); return (t >= 0 ? "+" : "") + formatMoney(t); })()}
                  </td>
                  <td className="px-3 py-2 border-t border-slate-200"></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
