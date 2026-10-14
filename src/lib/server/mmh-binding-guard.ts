import type { SessionAuthMethod } from "@/lib/server/session-cookies";

export type MmhBindingChangeRefusal = {
  ok: false;
  code: "MMH_BINDING_CHANGE_REQUIRES_LOCAL";
  error: string;
};

/**
 * Who may change an MMH binding (bind, re-bind, unbind).
 *
 * Every one of these operations edits which MMH account a local ledger user IS,
 * so they all share one rule: the session must not be an MMH session.
 *
 * An MMH session already acts as that identity. Letting it rewrite bindings adds
 * no capability it does not already have — the MMH password it would present as
 * proof is the very credential it holds — while handing a single-factor session
 * the power to attach or detach other local users from memberships. So these
 * operations are reserved for a local-password or fnOS session, where the
 * operator acts on the ledger rather than as the MMH user.
 *
 * Returns the refusal payload when the session may not act, or null when it may.
 * Callers keep their own permission checks and their own response shape (each
 * route has its own CORS headers); this only answers which KIND of identity is
 * allowed to act.
 */
export function refuseMmhSessionBindingChange(
  authMethod: SessionAuthMethod | null | undefined,
): MmhBindingChangeRefusal | null {
  if (authMethod !== "mmh") return null;
  return {
    ok: false,
    code: "MMH_BINDING_CHANGE_REQUIRES_LOCAL",
    error: "绑定或取消 MMH 绑定需由本地账号登录后操作：MMH 登录本身无法证明对绑定数据的修改权。",
  };
}