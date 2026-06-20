/**
 * API 认证辅助模块
 *
 * 混合认证策略：
 * 1. 优先尝试 cookie-based session auth（浏览器用户）
 * 2. 回退到 X-Api-Key header auth（Android / 外部客户端）
 *
 * X-Api-Key 验证方式：将 API Key 视为用户密码进行 bcrypt 验证
 * 通过后返回对应用户的 HouseholdContext
 */
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope, type HouseholdContext } from "@/lib/server/household-scope";
import { verifyPassword } from "@/lib/auth/password";

function getProvidedApiKey(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const key = req.headers.get("x-api-key");
  return key?.trim() || null;
}

/**
 * 获取 API 请求的 HouseholdContext。
 *
 * 先尝试 cookie session auth（getHouseholdScope），
 * 如果失败或当前无 cookie 登录态，则尝试 X-Api-Key header auth。
 *
 * @throws Error 两种认证均失败时抛出
 */
export async function getApiHouseholdScope(req: Request): Promise<HouseholdContext> {
  // Strategy 1: cookie-based session auth
  try {
    const ctx = await getHouseholdScope();
    // 如果成功获取到 householdId 且 user 存在，直接返回
    if (ctx.householdId) {
      return ctx;
    }
  } catch {
    // 忽略 cookie 异常，降级到 API Key
  }

  // Strategy 2: X-Api-Key header auth
  const apiKey = getProvidedApiKey(req);
  if (!apiKey) {
    throw new Error("未授权：缺少认证信息");
  }

  // 查找系统管理员用户，用 API Key 作为密码验证
  const adminUser = await prisma.user.findFirst({
    where: { OR: [{ role: "admin" }, { isSystem: true }] },
    orderBy: [{ isSystem: "desc" }, { createdAt: "asc" }],
    select: { id: true, name: true, role: true, isSystem: true, householdId: true, passwordHash: true },
  });

  if (!adminUser) {
    throw new Error("系统未配置管理员用户");
  }

  // 验证密码
  if (adminUser.passwordHash) {
    const valid = await verifyPassword(apiKey, adminUser.passwordHash);
    if (!valid) {
      throw new Error("API Key 无效");
    }
  } else {
    // 无密码哈希 → 检查旧版 access_password SystemSetting
    const legacy = await prisma.systemSetting.findUnique({
      where: { key: "access_password" },
    });
    if (legacy && legacy.value.length > 0) {
      if (apiKey !== legacy.value) {
        throw new Error("API Key 无效");
      }
    } else {
      throw new Error("系统未设置密码，请先在 Web 端设置");
    }
  }

  // 获取或确定 household
  let household = await prisma.household.findFirst({
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });

  if (!household) {
    // 无任何账簿 → 让 getHouseholdScope 创建默认账簿
    // 但这里无法直接调用（需要 cookies），所以返回错误
    throw new Error("无可用账簿");
  }

  return {
    householdId: household.id,
    hidFilter: { householdId: household.id },
    user: {
      id: adminUser.id,
      name: adminUser.name,
      role: adminUser.role,
      isSystem: adminUser.isSystem,
      householdId: adminUser.householdId,
    },
  };
}

/**
 * 从请求中提取 API Key（不验证）
 */
export { getProvidedApiKey };