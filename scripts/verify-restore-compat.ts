/**
 * 新版恢复旧版备份的回归关卡：「0.1.77 的备份 → 当前版本的恢复」
 * =====================================================================
 *
 * 备份是跨版本 / 跨设备 / 跨数据库引擎的便携文档，恢复流程必须保证**老版本备份在
 * 新版本上一定能恢复**，而不是靠事后一个个补字段。这个脚本把这条保证变成可执行的检查：
 *
 *   1. 建一个临时数据库（默认连开发库所在的 PostgreSQL，库名随机，结束即删）；
 *   2. 用当前代码造一本最小但形状完整的账簿，导出成备份包；
 *   3. 把备份包**降级成 v0.1.77 的形状**（见下方 `downgradeToV0177`，差异清单来自
 *      `git diff v0.1.77..HEAD -- src/lib/server/backup.ts` 的 data 键差集：只有
 *      `householdPreferences` 是 0.1.78 新增的）；
 *   4. 把它恢复到**另一个 householdId** 的账簿（模拟换设备/另一套安装），检查：
 *      - 整个过程不抛错；
 *      - 内置贷款类别是目标账簿的派生 id，且没有多出重复行；
 *      - 贷款账户的 loanCategoryId 指向目标账簿的内置类别；
 *      - 备份里没有的 `HouseholdPreference` 不会被清空（0.1.78 起才有的表）。
 *
 * 用法：`npm run check:restore-compat`（加 `--keep` 保留临时库便于排查）。
 * 默认复用开发库连接（配置见 `.codex/local-private-access.md`），可用
 * `RESTORE_COMPAT_ADMIN_URL` 指向别的 PostgreSQL。
 */
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";

import { Client } from "pg";

const ADMIN_URL =
  process.env.RESTORE_COMPAT_ADMIN_URL ??
  "postgresql://mmh-fs:mmh20261003@192.168.5.149:5433/mmh";
const keepDatabase = process.argv.includes("--keep");

const databaseName = `mmh_restore_compat_${randomBytes(4).toString("hex")}`;
const scratchUrl = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${databaseName}`;
  return url.toString();
})();

const log = (message: string) => console.log(`[restore-compat] ${message}`);

async function withAdminConnection<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

/**
 * 把当前版本的备份包降级成 v0.1.77 生成的形状。
 *
 * 差异来源（v0.1.77 → HEAD）：
 * - `data.householdPreferences` 是 0.1.78 新增的数组，老包没有；
 * - 内置贷款类别的 id 是 `lc_<householdId>_<baseType>`，老包里带的是**来源账簿**的派生值，
 *   所以这里把 house id 换成一台“别的设备”的 id，并把类别 id 与账户引用一起改过去。
 * - 版本新增差异时在这里追加一步，别在恢复代码里补丁式兼容。
 */
function downgradeToV0177(payload: Record<string, unknown>, sourceHouseholdId: string) {
  const raw = JSON.parse(JSON.stringify(payload)) as {
    scope: { householdId: string };
    data: {
      householdPreferences?: unknown;
      loanCategories: Array<Record<string, unknown>>;
      accounts: Array<Record<string, unknown>>;
    };
  };
  delete raw.data.householdPreferences;
  raw.scope.householdId = sourceHouseholdId;

  const remappedLoanCategories = new Map<string, string>();
  for (const category of raw.data.loanCategories) {
    const originalId = String(category.id);
    if (category.isSystem === true) {
      const nextId = `lc_${sourceHouseholdId}_${String(category.baseType ?? "other")}`;
      category.id = nextId;
      remappedLoanCategories.set(originalId, nextId);
    }
  }
  for (const account of raw.data.accounts) {
    if (account.loanCategoryId == null) continue;
    account.loanCategoryId = remappedLoanCategories.get(String(account.loanCategoryId)) ?? account.loanCategoryId;
  }
  return raw;
}

async function main() {
  log(`创建临时库 ${databaseName}`);
  await withAdminConnection(async (client) => {
    await client.query(`create database "${databaseName}"`);
  });

  log("同步当前 schema");
  execSync("npx prisma db push --accept-data-loss", {
    env: { ...process.env, DATABASE_URL: scratchUrl },
    stdio: "pipe",
  });

  // 必须在任何应用模块之前设置：`@/lib/db/prisma` 在模块加载时就建客户端。
  process.env.DATABASE_URL = scratchUrl;

  let disconnect: (() => Promise<unknown>) | null = null;
  const { prisma } = await import("../src/lib/db/prisma");
  const { builtinLoanCategoryId, BUILTIN_LOAN_CATEGORIES } = await import("../src/lib/server/loan-category");
  const { buildHouseholdBackupPayload, restoreHouseholdBackup } = await import("../src/lib/server/backup");

  disconnect = () => prisma.$disconnect();

  const sourceHouseholdId = `hh_src_${randomBytes(3).toString("hex")}`;
  const targetHouseholdId = `hh_dst_${randomBytes(3).toString("hex")}`;
  const failures: string[] = [];
  const check = (label: string, ok: boolean, detail = "") => {
    if (ok) {
      log(`OK   ${label}`);
      return;
    }
    failures.push(`${label}${detail ? ` (${detail})` : ""}`);
    log(`FAIL ${label}${detail ? ` (${detail})` : ""}`);
  };

  try {
    // ---- 来源账簿：最小但形状完整，覆盖“有类别的贷款账户”这一失败场景 ----
    log(`造来源账簿 ${sourceHouseholdId}`);
    await prisma.household.create({ data: { id: sourceHouseholdId, name: "来源账簿" } });
    await prisma.householdPreference.create({
      data: { householdId: sourceHouseholdId, timeZone: "Asia/Shanghai" },
    });
    const group = await prisma.accountGroup.create({
      data: { householdId: sourceHouseholdId, name: "默认分组" },
    });
    for (const category of BUILTIN_LOAN_CATEGORIES) {
      await prisma.loanCategory.create({
        data: {
          id: builtinLoanCategoryId(sourceHouseholdId, category.baseType),
          householdId: sourceHouseholdId,
          name: category.name,
          baseType: category.baseType,
          sortOrder: category.sortOrder,
          isSystem: true,
        },
      });
    }
    await prisma.account.create({
      data: {
        householdId: sourceHouseholdId,
        groupId: group.id,
        name: "房贷账户",
        kind: "loan",
        loanType: "home",
        loanCategoryId: builtinLoanCategoryId(sourceHouseholdId, "home"),
      },
    });
    await prisma.account.create({
      data: { householdId: sourceHouseholdId, groupId: group.id, name: "储蓄卡", kind: "bank_debit" },
    });

    const payload = await buildHouseholdBackupPayload(sourceHouseholdId, null);
    const oldPayload = downgradeToV0177(payload as unknown as Record<string, unknown>, sourceHouseholdId);
    check("降级后的包不带 0.1.78 新增字段", !("householdPreferences" in oldPayload.data));

    // 真实场景是「另一台设备」：来源库根本不在目标库里。留着来源行会让主键和备份里的
    // 行撞车（那是另一回事，会把测试变成假阳性）。
    await prisma.account.deleteMany({ where: { householdId: sourceHouseholdId } });
    await prisma.loanCategory.deleteMany({ where: { householdId: sourceHouseholdId } });
    await prisma.accountGroup.deleteMany({ where: { householdId: sourceHouseholdId } });
    await prisma.householdPreference.deleteMany({ where: { householdId: sourceHouseholdId } });
    await prisma.household.delete({ where: { id: sourceHouseholdId } });
    log("已移除来源账簿（模拟换设备：目标库中不存在来源行）");

    // ---- 目标账簿：模拟另一套安装（householdId 完全不同，自带设置行）----
    log(`造目标账簿 ${targetHouseholdId}`);
    await prisma.household.create({ data: { id: targetHouseholdId, name: "目标账簿" } });
    await prisma.householdPreference.create({
      data: { householdId: targetHouseholdId, timeZone: "Europe/Berlin" },
    });

    log("执行恢复（v0.1.77 的包 → 当前版本）");
    await restoreHouseholdBackup(oldPayload, { householdId: targetHouseholdId });
    check("恢复过程没有抛错", true);

    const categories = await prisma.loanCategory.findMany({
      where: { householdId: targetHouseholdId },
      select: { id: true, name: true, baseType: true },
    });
    const expectedCategoryIds = BUILTIN_LOAN_CATEGORIES.map((category) =>
      builtinLoanCategoryId(targetHouseholdId, category.baseType),
    );
    check(
      "内置贷款类别恰好四行且 id 是目标账簿派生值",
      categories.length === 4 && categories.every((row) => expectedCategoryIds.includes(row.id)),
      `rows=${JSON.stringify(categories.map((row) => row.id))}`,
    );

    const loanAccount = await prisma.account.findFirst({
      where: { householdId: targetHouseholdId, name: "房贷账户" },
      select: { loanCategoryId: true },
    });
    check(
      "贷款账户指向目标账簿的内置类别",
      loanAccount?.loanCategoryId === builtinLoanCategoryId(targetHouseholdId, "home"),
      `loanCategoryId=${String(loanAccount?.loanCategoryId)}`,
    );

    const accounts = await prisma.account.count({ where: { householdId: targetHouseholdId } });
    check("账户数量与备份一致", accounts === 2, `accounts=${accounts}`);

    const preference = await prisma.householdPreference.findUnique({
      where: { householdId: targetHouseholdId },
      select: { timeZone: true },
    });
    check(
      "老包不含设置行时不覆盖目标账簿设置",
      preference?.timeZone === "Europe/Berlin",
      `timeZone=${String(preference?.timeZone)}`,
    );

    if (failures.length > 0) {
      console.error(`\n[restore-compat] 失败 ${failures.length} 项：\n- ${failures.join("\n- ")}`);
      process.exitCode = 1;
      return;
    }
    log("全部通过");
  } finally {
    if (disconnect) await disconnect().catch(() => undefined);
    if (keepDatabase) {
      log(`保留临时库 ${databaseName}（${scratchUrl}）`);
    } else {
      await withAdminConnection(async (client) => {
        await client.query(`drop database if exists "${databaseName}"`);
      }).catch(() => undefined);
      log("临时库已删除");
    }
  }
}

void main().catch((error: unknown) => {
  console.error("[restore-compat] 运行失败：", error);
  process.exitCode = 1;
});
