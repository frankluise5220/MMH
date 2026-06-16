"use client";

import { useActionState } from "react";
import { setupPassword, type SetupState } from "./actions";

export function SetupForm() {
  const [state, formAction, pending] = useActionState(setupPassword, undefined as SetupState | undefined);

  return (
    <form className="p-6 space-y-4" action={formAction}>
      <div className="bg-amber-50 border border-amber-100 rounded-lg p-3 text-xs text-amber-700">
        密码对应的是数据库，不是用户。设置后所有访问此数据库的用户都需要输入此密码。
      </div>
      <input name="username" type="hidden" value="admin" />
      <div className="space-y-1">
        <div className="text-xs font-medium text-slate-600">设置密码</div>
        <input
          name="newPassword"
          type="password"
          autoComplete="new-password"
          className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
          placeholder="输入密码"
        />
      </div>
      <div className="space-y-1">
        <div className="text-xs font-medium text-slate-600">确认密码</div>
        <input
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
          placeholder="再次输入密码"
        />
      </div>
      {state?.error && <div className="text-sm text-red-600">{state.error}</div>}
      <button
        type="submit"
        className="h-10 w-full rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50"
        disabled={pending}
      >
        {pending ? "设置中…" : "设置并进入"}
      </button>
    </form>
  );
}
