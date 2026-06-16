"use client";

import { useActionState } from "react";
import { login, type LoginState } from "./actions";

export function LoginForm() {
  const [state, formAction, pending] = useActionState(login, undefined as LoginState | undefined);

  return (
    <form className="p-6 space-y-4" action={formAction}>
      <div className="space-y-1">
        <div className="text-xs font-medium text-slate-600">密码</div>
        <input
          name="username"
          type="hidden"
          value="admin"
        />
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
          placeholder="访问密码"
          autoFocus
        />
      </div>
      {state?.error && <div className="text-sm text-red-600">{state.error}</div>}
      <button
        type="submit"
        className="h-10 w-full rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50"
        disabled={pending}
      >
        {pending ? "验证中…" : "进入"}
      </button>
    </form>
  );
}
