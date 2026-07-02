import Link from "next/link";
import {
  BookOpen,
  Building2,
  Cpu,
  Database,
  Handshake,
  Mail,
  Palette,
  Shield,
  Tag,
  Users,
} from "lucide-react";

const quickSettings = [
  { href: "/settings/accounts", label: "账户", desc: "账户、所有人、账户类型", icon: Users },
  { href: "/settings/institutions", label: "机构", desc: "银行、保险、券商和支付机构", icon: Building2 },
  { href: "/settings/counterparties", label: "往来对象", desc: "往来人员、债权债务和其他对象", icon: Handshake },
  { href: "/settings/categories", label: "收支类别", desc: "收入、支出、代付分类", icon: Tag },
  { href: "/settings/email", label: "邮箱账户", desc: "账单读取和发件账户", icon: Mail },
  { href: "/settings/password-recovery", label: "密码找回", desc: "找回密码开关和发件设置", icon: Shield },
  { href: "/settings/display", label: "显示", desc: "颜色、时间和界面偏好", icon: Palette },
  { href: "/settings/ai", label: "AI 模型", desc: "识别和分析模型配置", icon: Cpu },
  { href: "/settings/ledgers", label: "账簿", desc: "当前账簿和基础资料", icon: BookOpen },
  { href: "/settings/database", label: "数据库", desc: "备份、维护和数据连接", icon: Database },
];

export default function SettingsPage() {
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white px-4 py-4">
        <h2 className="text-sm font-semibold text-slate-800">系统设置</h2>
        <p className="mt-1 text-xs text-slate-500">
          选择左侧菜单或下方快捷入口进入具体设置。此页不预加载账户明细，打开会更快。
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {quickSettings.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className="group rounded-xl border border-slate-200 bg-white px-4 py-3 transition-colors hover:border-blue-200 hover:bg-blue-50/40"
            >
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500 transition-colors group-hover:bg-blue-100 group-hover:text-blue-600">
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-slate-800">{item.label}</span>
                  <span className="mt-0.5 block truncate text-xs text-slate-500">{item.desc}</span>
                </span>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
