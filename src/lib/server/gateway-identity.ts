/**
 * 飞牛统一网关身份（fnOS unified-gateway identity）。
 *
 * 应用挂在 fnOS 统一网关后面时（`app/ui/config` 声明 `gatewaySocket`），
 * 网关先校验 fnOS 登录态，再把当前用户透传给应用：
 *
 *   X-Trim-Userid    当前用户的数字 UID，例如 `1001`
 *   X-Trim-Username  当前用户的登录用户名，例如 `jsbyfubin`
 *   X-Trim-Isadmin   `true` / `false`
 *
 * 账簿用户绑定的飞牛身份存在 `User.fnosUid`（账本内唯一）。这个字段历史上
 * 存的是**数字 UID**，但数字 UID 用户在飞牛界面上看不到、也没法自证，
 * 所以绑定窗口现在以**飞牛用户名**为准；数字 UID 只作为老记录的兼容匹配项
 * （飞牛用户改名之前绑定的记录仍然能登录）。
 *
 * 判定顺序固定：先按用户名匹配，未命中再退回数字 UID。
 */

export interface GatewayFnosIdentity {
  /** 数字 UID（`X-Trim-Userid`），缺失时为空串。 */
  uid: string;
  /** 登录用户名（`X-Trim-Username`），缺失时为空串。 */
  username: string;
  /**
   * 用于匹配 `User.fnosUid` 的候选值，**用户名优先**。
   * 顺序有语义：先命中用户名的记录，没命中再退回数字 UID 的老记录。
   */
  keys: string[];
}

/** 从请求头解析飞牛网关注入的身份；不在网关后面时返回 null。 */
export function readGatewayFnosIdentity(
  headers: { get(name: string): string | null },
): GatewayFnosIdentity | null {
  const uid = headers.get("x-trim-userid")?.trim() ?? "";
  const username = headers.get("x-trim-username")?.trim() ?? "";
  if (!uid && !username) return null;
  const keys = [username, uid].filter((value, index, all) => value.length > 0 && all.indexOf(value) === index);
  return { uid, username, keys };
}

/**
 * 当前请求携带的飞牛身份是否等于给定值（飞牛用户名或数字 UID 任一即可）。
 * 用于校验客户端回传的身份，避免客户端冒用任意飞牛账号。
 */
export function matchesGatewayFnosIdentity(
  identity: GatewayFnosIdentity | null,
  value: string | null | undefined,
): boolean {
  const target = (value ?? "").trim();
  if (!identity || !target) return false;
  return identity.keys.includes(target);
}
