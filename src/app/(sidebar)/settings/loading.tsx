import { Loader2 } from "lucide-react";

export default function SettingsLoading() {
  return (
    <div className="flex h-[calc(100vh-8rem)] items-start justify-center pt-16">
      <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500 shadow-sm">
        <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
        正在打开设置...
      </div>
    </div>
  );
}
