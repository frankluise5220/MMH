import { builtinLoanCategoryId } from "@/lib/server/loan-category";
import type { LoanTypeValue } from "@/lib/loan-type";

/**
 * 备份「标识归一化」：新版恢复旧版备份的兼容契约
 * =====================================================================
 *
 * 备份包是一份**跨版本、跨设备、跨数据库引擎**的便携文档：它由 0.1.77 的 PostgreSQL
 * 部署生成，可能在 0.1.78 的飞牛（SQLite）安装上恢复，目标账簿的 `householdId` 与来源
 * 完全不同。因此恢复不是「把 JSON 里的行原样塞进库」，而是：
 *
 *   1. 逐列映射：老备份没有的新列走默认值、新备份多出来的列忽略（写入阶段的列白名单负责，
 *      由 `npm run check:backup` 中的 check-restore-field-coverage 把关）；
 *   2. **标识归一化（本文件）**：凡是**从来源环境派生出来的标识**，都不能原样落到目标环境，
 *      必须按目标环境重算，并且所有指向它的外键要一起改；
 *   3. 幂等兜底：能在运行期被「补齐」主数据的表（内置贷款类别、默认分类树）补数据时必须
 *      按名字认领已有行，绝不按派生 id 假定存在。
 *
 * 第 2 条曾经缺失，第 3 条只做对了一半，结果是 0.1.78 恢复 0.1.77 备份时在 60% 直接
 * 失败：内置贷款类别的 id 是 `lc_<householdId>_<baseType>`，备份里带的是**来源账簿**的
 * 派生值；原样写入后本账簿的派生 id 不存在，`ensureBuiltinLoanCategories()` 认为四个类别
 * 全缺、按名字再插一遍，撞上 `(householdId, name)` 唯一索引（P2002），整个恢复事务回滚。
 * 用户看到的就是 “Restore failed 60%”。
 *
 * 新增派生标识时**只改这一个文件**，并在 `scripts/verify-restore-compat.ts` 的
 * “v0.1.77 降级变换”里补一步，让「老版本备份 → 新版本恢复」始终有回归关卡。
 *
 * 目前登记在案的派生标识：
 * - 内置贷款类别 id `lc_<householdId>_<baseType>`（Prisma 迁移、Docker 回填、SQLite 迁移、
 *   备份恢复四条路径都按这个规则生成，见 `loan-category.ts`）。
 *
 * 不属于本文件、但同样必须保持便携的规则（就地实现，勿在本文件重复）：
 * - `SystemSetting` 中带 householdId 的键，写入时按目标账簿重写，并丢弃 installation id
 *   （见 `backup.ts` 的 `remapHouseholdSystemSettingKey` 与 `INSTALLATION_ID_SETTING_KEY`）。
 */

/** 备份里的一条记录：解析后是松散对象，列映射由写入阶段负责。 */
type BackupRow = Record<string, unknown>;

type RestoreIdentityPayload = {
  scope: { householdId: string };
  data: {
    loanCategories: BackupRow[];
    accounts: BackupRow[];
  };
};

type RestoreIdentity = {
  /** 备份里的贷款类别 id → 目标账簿里的贷款类别 id。 */
  loanCategories: Map<string, string>;
};

/**
 * 把 `payload` 里所有从来源环境派生的标识重算成目标环境的标识。
 *
 * 直接在传入的 payload 上原地改写，调用点（`restoreHouseholdBackup`）在解析之后、任何写入
 * 之前调用一次，后面的写入阶段就只需要逐列映射，不再关心兼容性。
 */
export function normalizeRestoreIdentity(
  payload: RestoreIdentityPayload,
  householdId: string,
): RestoreIdentity {
  const sourceHouseholdId = payload.scope.householdId;
  const loanCategories = new Map<string, string>();
  const usedIds = new Set<string>();

  for (const item of payload.data.loanCategories) {
    const payloadId = String(item.id ?? "").trim();
    const baseType = String(item.baseType ?? "other");
    // 内置判定的两个口径都要认：0.1.77 起写入的行都带 isSystem = true；更早的行可能
    // 由一个「按 householdId 派生 id」的迁移或 db push 生成，那就用派生值比对。
    const isBuiltin =
      item.isSystem === true ||
      payloadId === builtinLoanCategoryId(sourceHouseholdId, baseType as LoanTypeValue);
    const preferredId = isBuiltin
      ? builtinLoanCategoryId(householdId, baseType as LoanTypeValue)
      : payloadId;
    // 同一 baseType 出现两行（历史脏数据）时退回来源 id，避免两行抢同一个主键。
    const id = usedIds.has(preferredId) ? payloadId : preferredId;
    usedIds.add(id);
    loanCategories.set(payloadId, id);
    item.id = id;
  }

  for (const account of payload.data.accounts) {
    if (account.loanCategoryId == null) continue;
    const mapped = loanCategories.get(String(account.loanCategoryId));
    // 指向备份里不存在的类别：置空，让下面的「按口径回填」逻辑接手。
    account.loanCategoryId = mapped ?? null;
  }

  return { loanCategories };
}
