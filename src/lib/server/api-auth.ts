/**
 * API authentication helpers.
 *
 * Mixed authentication strategy:
 * 1. Try cookie-based session auth first (browser users)
 * 2. Fall back to X-Api-Key header auth (Android / external clients)
 *
 * X-Api-Key verification: the API Key is treated as the user password and verified with bcrypt.
 * On success, returns the HouseholdContext of the matching user.
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
 * Get the HouseholdContext for an API request.
 *
 * First tries cookie session auth (getHouseholdScope); if that fails or there is no
 * cookie login state, falls back to X-Api-Key header auth.
 *
 * @throws Error when both authentication methods fail
 */
export async function getApiHouseholdScope(req: Request): Promise<HouseholdContext> {
  // Strategy 1: cookie-based session auth
  try {
    const ctx = await getHouseholdScope();
    // If householdId was resolved and the user exists, return it directly
    if (ctx.householdId) {
      return ctx;
    }
  } catch {
    // Ignore cookie errors and fall back to the API Key
  }

  // Strategy 2: X-Api-Key header auth
  const apiKey = getProvidedApiKey(req);
  if (!apiKey) {
    throw new Error("未授权：缺少认证信息");
  }

  // Find the system admin user and verify the API Key as its password
  const adminUser = await prisma.user.findFirst({
    where: { OR: [{ role: "admin" }, { isSystem: true }] },
    orderBy: [{ isSystem: "desc" }, { createdAt: "asc" }],
    select: { id: true, name: true, role: true, isSystem: true, householdId: true, passwordHash: true },
  });

  if (!adminUser) {
    throw new Error("系统未配置管理员用户");
  }

  // Verify the password
  if (adminUser.passwordHash) {
    const valid = await verifyPassword(apiKey, adminUser.passwordHash);
    if (!valid) {
      throw new Error("API Key 无效");
    }
  } else {
    // No password hash → check the legacy access_password SystemSetting
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

  // Resolve the household
  let household = await prisma.household.findFirst({
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });

  if (!household) {
    // No household exists → getHouseholdScope would create a default one,
    // but it cannot be called here (it needs cookies), so return an error instead.
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
 * Extract the API Key from a request (without verification).
 */
export { getProvidedApiKey };