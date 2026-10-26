/**
 * 「账户所有人」的统一取数口径（纯函数，客户端组件也会 import）。
 *
 * 产品规则（2026-10-15 确认）：**账户所有人就是家庭成员**。
 * `AccountGroup.institutionId` 指向的 `Institution(type = "family_member")` 行与它就是
 * 同一个人（见 `src/lib/server/account-group-member-pairing.ts`），人名的权威来源是
 * 家庭成员，所以所有「账户所有人」的选项与展示一律用家庭成员的姓名渲染。
 *
 * 首次赋值来自飞牛免密登录名还是本地建账时的管理员名都无所谓：用户在
 * 「设置 → 家庭成员」改名即可，改名会双向同步分组名与成员名。
 *
 * 分组名只在这两种情况下兜底：
 * 1. 未配对（自愈还没跑到，或建成员时因重名冲突被跳过）；
 * 2. 功能分组（未指定 / 负债 / 往来款 …），它们本来就不对应某个人。
 *
 * `value` 仍然是 `AccountGroup.id`：账户、保险等数据都按 `groupId` 关联，
 * 筛选与写入沿用分组 id，不因展示名变化而改变。
 */

type AccountOwnerGroupLike = {
  id: string;
  name: string;
  /** `AccountGroup.institutionId`：配对家庭成员的 id */
  institutionId?: string | null;
};

type AccountOwnerMemberLike = {
  id: string;
  name: string;
};

type AccountOwnerOption = {
  /** `AccountGroup.id` */
  id: string;
  /** 展示名：配对家庭成员的姓名（兜底：分组名） */
  name: string;
};

export function buildAccountOwnerOptions(
  groups: ReadonlyArray<AccountOwnerGroupLike>,
  familyMembers: ReadonlyArray<AccountOwnerMemberLike>,
): AccountOwnerOption[] {
  const memberNameById = new Map<string, string>();
  for (const member of familyMembers) {
    const name = member.name?.trim();
    if (name) memberNameById.set(member.id, name);
  }
  return groups.map((group) => ({
    id: group.id,
    name: (group.institutionId ? memberNameById.get(group.institutionId) : "") || group.name,
  }));
}

/** 只保留有账户挂在名下的所有人（报表 / 统计的筛选下拉），保持传入顺序。 */
export function filterAccountOwnersWithGroupIds(
  options: ReadonlyArray<AccountOwnerOption>,
  groupIds: Iterable<string | null | undefined>,
): AccountOwnerOption[] {
  const presentGroupIds = new Set<string>();
  for (const groupId of groupIds) {
    if (groupId) presentGroupIds.add(groupId);
  }
  return options.filter((option) => presentGroupIds.has(option.id));
}

/** 分组 id → 展示名，用于按 `groupId` 关联的行（例如账户列表的「所有人」列）。 */
export function accountOwnerNameById(
  options: ReadonlyArray<AccountOwnerOption>,
): Map<string, string> {
  return new Map(options.map((option) => [option.id, option.name]));
}
