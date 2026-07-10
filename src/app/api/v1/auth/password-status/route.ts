import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { logger } from "@/lib/logger";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { cookies } from "next/headers";
import { hasEmailService } from "@/lib/mail/passwordReset";
import { createDefaultCategoriesForHousehold } from "@/lib/default-categories";
import { createDefaultInstitutionsForHousehold } from "@/lib/default-institutions";
import { getDefaultTradingCalendarForAccount } from "@/lib/fund/trading-calendar";

const LEGACY_PASSWORD_KEY = "access_password";
const STATUS_LOOKUP_TIMEOUT_MS = 900;

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => resolve(null), timeoutMs);
  });

  try {
    return await Promise.race([operation.catch(() => null), timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function degradedStatusResponse() {
  return NextResponse.json({
    ok: true,
    degraded: true,
    hasPassword: true,
    passwordResetEnabled: false,
    users: [],
  });
}

async function ensureInitialHousehold(adminName: string) {
  const ownerName = adminName.trim() || "admin";
  let household = await prisma.household.findFirst({ select: { id: true }, orderBy: { createdAt: "asc" } });
  let createdHousehold = false;

  if (!household) {
    household = await prisma.household.create({ data: { name: "默认" }, select: { id: true } });
    createdHousehold = true;
  }

  let defaultOwner = await prisma.accountGroup.findFirst({
    where: { householdId: household.id, name: ownerName },
    select: { id: true },
  });
  if (!defaultOwner) {
    const groupCount = await prisma.accountGroup.count({ where: { householdId: household.id } });
    defaultOwner = await prisma.accountGroup.create({
      data: { name: ownerName, householdId: household.id, sortOrder: groupCount },
      select: { id: true },
    });
  }

  const accountCount = await prisma.account.count({ where: { householdId: household.id } });
  if (accountCount === 0) {
    const defaultAccounts: { name: string; kind: string; investProductType?: string }[] = [
      { name: "现金钱包", kind: "cash" },
      { name: "银行储蓄", kind: "bank_debit" },
      { name: "投资账户", kind: "investment", investProductType: "fund" },
    ];
    for (const account of defaultAccounts) {
      await prisma.account.create({
        data: {
          name: account.name,
          kind: account.kind as any,
          groupId: defaultOwner.id,
          investProductType: account.investProductType as any,
          tradingCalendar: getDefaultTradingCalendarForAccount(account.kind, account.investProductType) as any,
          householdId: household.id,
          isActive: true,
          currency: "CNY",
        },
      });
    }
  }

  if (createdHousehold) {
    await createDefaultCategoriesForHousehold(prisma, household.id);
    await createDefaultInstitutionsForHousehold(prisma, household.id);
  }

  return household.id;
}

/**
 * GET /api/v1/auth/password-status
 * 检查系统是否有任何用户设置了密码（或旧 SystemSetting 密码）
 * 返回的用户列表按当前账簿过滤：
 * - 系统用户（isSystem=true）不绑定账簿，始终显示
 * - 普通用户只显示属于当前 householdId 的用户
 */
export async function GET() {
  const cookieStore = await cookies();
  const householdId = cookieStore.get("householdId")?.value;
  const status = await withTimeout(Promise.all([
    prisma.user.findFirst({
      where: { passwordHash: { not: null } },
      select: { id: true },
    }),
    prisma.systemSetting.findUnique({
      where: { key: LEGACY_PASSWORD_KEY },
      select: { value: true },
    }),
    prisma.user.findMany({
      select: { id: true, name: true, passwordHash: true, role: true, isSystem: true, householdId: true },
      where: householdId
        ? {
            OR: [
              { isSystem: true },
              { householdId: householdId },
            ],
          }
        : undefined,
      orderBy: { name: "asc" },
    }),
    hasEmailService(householdId ?? undefined),
  ]), STATUS_LOOKUP_TIMEOUT_MS);

  if (!status) {
    return degradedStatusResponse();
  }

  const [userWithPassword, legacy, users, passwordResetEnabled] = status;
  const hasPassword = !!userWithPassword || (!!legacy && legacy.value.length > 0);

  return NextResponse.json({
    ok: true,
    hasPassword,
    passwordResetEnabled,
    users: users.map(u => ({ id: u.id, name: u.name, hasPassword: !!u.passwordHash, role: u.role, isSystem: u.isSystem })),
  });
}

/**
 * POST /api/v1/auth/password-status
 * 为用户设置或修改密码，首次设置时创建 admin 用户
 * Body: { userId?: string, username?: string, password: string, currentPassword?: string }
 */
export async function POST(req: NextRequest) {
  const body = await req.json() as { userId?: string; username?: string; password?: string; currentPassword?: string };
  const newPassword = (body.password ?? "").trim();
  const userId = body.userId?.trim();
  const username = (body.username ?? "").trim();

  // 查找目标用户
  let user = userId
    ? await prisma.user.findUnique({ where: { id: userId } })
    : username
      ? await prisma.user.findFirst({ where: { name: username } })
      : null;

  // 如果没找到且指定了 username，首次设置时创建当前账簿管理员用户
  if (!user && username) {
    const existingUser = await prisma.user.findFirst({ select: { id: true } });
    const isFirstUser = !existingUser;
    let householdId: string | null = null;

    if (isFirstUser) {
      householdId = await ensureInitialHousehold(username);
    } else if (username !== "admin") {
      const { hidFilter } = await getHouseholdScope();
      householdId = hidFilter.householdId;
    }

    user = await prisma.user.create({
      data: { name: username, role: isFirstUser ? "admin" : "user", isSystem: false, householdId },
    });
  }

  if (!user) {
    return NextResponse.json({ ok: false, error: "用户不存在" }, { status: 404 });
  }

  // 如果用户已有密码哈希，需要验证当前密码
  if (user.passwordHash) {
    const currentPassword = (body.currentPassword ?? "").trim();
    if (!currentPassword) {
      return NextResponse.json({ ok: false, error: "请输入当前密码" }, { status: 401 });
    }
    const match = await verifyPassword(currentPassword, user.passwordHash);
    if (!match) {
      return NextResponse.json({ ok: false, error: "当前密码错误" }, { status: 401 });
    }
  } else {
    // 迁移桥接：如果存在旧 SystemSetting 密码，需要先验证旧密码
    const legacy = await prisma.systemSetting.findUnique({
      where: { key: LEGACY_PASSWORD_KEY },
    });
    if (legacy && legacy.value.length > 0) {
      const currentPassword = (body.currentPassword ?? "").trim();
      if (currentPassword !== legacy.value) {
        return NextResponse.json({ ok: false, error: "当前密码错误" }, { status: 401 });
      }
      // 删除旧密码（迁移完成）
      await prisma.systemSetting.delete({ where: { key: LEGACY_PASSWORD_KEY } }).catch(logger.catchLog("操作失败", "route.ts"));
    }
  }

  if (newPassword) {
    const hashed = await hashPassword(newPassword);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: hashed },
    });
  } else {
    // 清除密码（不建议但允许）
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: null },
    });
  }

  return NextResponse.json({ ok: true });
}
