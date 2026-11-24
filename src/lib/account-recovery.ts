/**
 * 「账号还有没有找回方式」的唯一口径。
 *
 * 本地密码忘了能不能自己救回来，只看账号有没有一条**不依赖本站密码**的通道：
 *  - 绑定邮箱（User.email）：找回验证码发到这个地址；
 *  - MMH 账户绑定（registrationPrincipalId）：由 MMH membership 认证，密码可在外站重设；
 *  - 飞牛绑定（fnosUid）：走网关免密登录，本机密码忘了也进得来。
 *
 * 三条全缺 = 忘记密码只能请管理员在「设置 → 用户管理」里改密；若唯一的管理员也忘了，
 * 整套账簿就再也打不开 —— 这就是用户要求提示「忘记密码可能丢失账簿」的风险。
 *
 * 纯函数，服务端（通知栏）与客户端（用户管理页警告条）必须共用，不要各写一份判定，
 * 否则两边警告的名单迟早会对不上。
 */

export type AccountRecoveryIdentity = {
  email?: string | null;
  fnosUid?: string | null;
  registrationPrincipalId?: string | null;
};

/** 该账号是否存在至少一条可自助找回/绕过本地密码的通道。 */
export function hasAccountRecovery(identity: AccountRecoveryIdentity): boolean {
  return Boolean(
    identity.email?.trim() ||
      identity.fnosUid?.trim() ||
      identity.registrationPrincipalId?.trim(),
  );
}

/** 从用户列表里筛出没有任何找回通道的账号（保持入参顺序）。 */
export function usersMissingAccountRecovery<
  T extends AccountRecoveryIdentity & { id: string; name: string },
>(users: readonly T[]): T[] {
  return users.filter((user) => !hasAccountRecovery(user));
}
