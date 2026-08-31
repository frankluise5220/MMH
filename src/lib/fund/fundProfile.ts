import { Prisma } from "@prisma/client";

import { countTradingDaysUtc } from "@/lib/date-utils";

import { queryFundProfile, queryFundIdentity } from "@/lib/fund/queryApi";

/**
 * Fund profile (fund company / custodian / manager) persistence.
 *
 * A fund's profile is a fund-level attribute keyed by fundCode, shared across
 * all accounts and households that hold the same fund. It is stored once per
 * fund code (upsert), so repeated NAV fetches do not duplicate rows.
 */

export type FundProfileRecord = {
  fundCode: string;
  fundName: string | null;
  fundCompany: string | null;
  custodian: string | null;
  manager: string | null;
  navDateOffset: number;
};

export type FundNavDateOffset = 0 | 1;

export type FundProfileUpdate = {
  fundName?: string | null;
  fundCompany?: string | null;
  custodian?: string | null;
  manager?: string | null;
  navDateOffset?: FundNavDateOffset;
};

export type FundProfileContext = {
  householdId?: string | null;
};

type FundProfileSqlRow = {
  fundCode: string;
  fundName: string | null;
  fundCompany: string | null;
  custodian: string | null;
  manager: string | null;
  navDateOffset: number | bigint | null;
};

function normalizeNavDateOffset(value: unknown) {
  const n = Number(value ?? 0);
  return n === 1 ? 1 : 0;
}

function utcDateKey(value: Date | string) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const match = value.trim().match(/^\d{4}-\d{2}-\d{2}/);
  if (!match) throw new Error("lastNavDate must be an ISO date.");
  return match[0];
}

/** Return the trading calendar used by the fund's latest NAV publication. */
export function fundTradingCalendarForName(name: string | null | undefined) {
  return /QDII|\u6807\u666e|\u7EB3\u65AF\u8FBE\u514B|\u7EB3\u6307|\u9053\u743C\u65AF|\u7F8E\u56FD|\u5168\u7403|\u6052\u751F|\u65E5\u672C/i.test(String(name ?? ""))
    ? "us_fund"
    : "cn_fund";
}

/**
 * Derive the binary NAV date offset from the latest fetched NAV and the current
 * date. The comparison is made in trading days, not calendar days, so a Friday
 * NAV is current on a Sunday for a domestic fund while a Thursday NAV remains
 * one trading day behind for a QDII fund whose Friday NAV is not published yet.
 * The stored value is intentionally binary: 0 for current and 1 for lagging.
 */
export function deriveFundNavDateOffset(
  lastNavDate: Date | string,
  now: Date = new Date(),
  tradingCalendar = "cn_fund",
): FundNavDateOffset {
  const lastKey = utcDateKey(lastNavDate);
  const nowKey = utcDateKey(now);
  if (lastKey >= nowKey) return 0;
  const tradingDays = countTradingDaysUtc(lastKey, nowKey, tradingCalendar);
  return tradingDays != null && tradingDays <= 0 ? 0 : 1;
}

function hasFetchedFundProfileData(profile: FundProfileRecord | null) {
  return Boolean(
    profile?.fundName?.trim() ||
    profile?.fundCompany?.trim() ||
    profile?.custodian?.trim() ||
    profile?.manager?.trim(),
  );
}

function toFundProfileRecord(row: FundProfileSqlRow): FundProfileRecord {
  return {
    fundCode: row.fundCode,
    fundName: row.fundName,
    fundCompany: row.fundCompany,
    custodian: row.custodian,
    manager: row.manager,
    navDateOffset: normalizeNavDateOffset(row.navDateOffset),
  };
}

async function getPrismaClient() {
  const { prisma } = await import("@/lib/db/prisma");
  return prisma;
}

/**
 * Ensure a recognized fund company is available as a household institution.
 * FundProfile is shared by fund code, while Institution is household-scoped.
 */
export async function ensureFundCompanyInstitution(
  householdId: string | null | undefined,
  fundCompany: string | null | undefined,
) {
  const name = String(fundCompany ?? "").trim();
  if (!householdId || !name) return null;

  const prisma = await getPrismaClient();
  return prisma.$transaction(async (tx) => {
    const existing = await tx.institution.findFirst({
      where: {
        householdId,
        OR: [{ name }, { shortName: name }],
      },
      orderBy: { name: "asc" },
    });
    if (existing) {
      if (existing.type === "fund_company") return existing;
      return tx.institution.update({ where: { id: existing.id }, data: { type: "fund_company" } });
    }

    return tx.institution.create({
      data: {
        name,
        type: "fund_company",
        householdId,
      },
    });
  });
}

export async function syncFundCompanyInstitution(
  profile: FundProfileRecord,
  context?: FundProfileContext,
) {
  if (!context?.householdId || !profile.fundCompany) return;
  try {
    await ensureFundCompanyInstitution(context.householdId, profile.fundCompany);
  } catch (error) {
    console.warn("Failed to sync recognized fund company institution", {
      householdId: context.householdId,
      fundCode: profile.fundCode,
      fundCompany: profile.fundCompany,
      error,
    });
  }
}

const FUND_PROFILE_SELECT = Prisma.sql`
  SELECT
    "fundCode",
    "fundName",
    "fundCompany",
    "custodian",
    "manager",
    "navDateOffset"
  FROM "FundProfile"
`;

async function readFundProfileRow(fundCode: string) {
  const prisma = await getPrismaClient();
  const rows = await prisma.$queryRaw<FundProfileSqlRow[]>(Prisma.sql`
    ${FUND_PROFILE_SELECT}
    WHERE "fundCode" = ${fundCode}
    LIMIT 1
  `);
  return rows[0] ?? null;
}

async function upsertFundProfileOffset(fundCode: string, navDateOffset: number) {
  return updateFundProfile(fundCode, { navDateOffset: normalizeNavDateOffset(navDateOffset) });
}

async function writeFundProfile(params: {
  fundCode: string;
  fundName: string | null;
  fundCompany: string | null;
  custodian: string | null;
  manager: string | null;
  navDateOffset: number;
}) {
  const prisma = await getPrismaClient();
  const rows = await prisma.$queryRaw<FundProfileSqlRow[]>(Prisma.sql`
    INSERT INTO "FundProfile" (
      "fundCode",
      "fundName",
      "fundCompany",
      "custodian",
      "manager",
      "navDateOffset",
      "createdAt",
      "updatedAt"
    )
    VALUES (
      ${params.fundCode},
      ${params.fundName},
      ${params.fundCompany},
      ${params.custodian},
      ${params.manager},
      ${params.navDateOffset},
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT ("fundCode") DO UPDATE SET
      "fundName" = EXCLUDED."fundName",
      "fundCompany" = EXCLUDED."fundCompany",
      "custodian" = EXCLUDED."custodian",
      "manager" = EXCLUDED."manager",
      "navDateOffset" = EXCLUDED."navDateOffset",
      "updatedAt" = CURRENT_TIMESTAMP
    RETURNING
      "fundCode",
      "fundName",
      "fundCompany",
      "custodian",
      "manager",
      "navDateOffset"
  `);
  return toFundProfileRecord(rows[0]!);
}

/** Update editable fund-level metadata without changing account-level rules. */
export async function updateFundProfile(fundCode: string, update: FundProfileUpdate) {
  const code = fundCode.trim();
  if (!/^\d{6}$/.test(code)) throw new Error("fundCode must be a six-digit fund code.");
  if (update.navDateOffset !== undefined && update.navDateOffset !== 0 && update.navDateOffset !== 1) {
    throw new Error("navDateOffset must be 0 or 1.");
  }
  const current = await getFundProfile(code);
  return writeFundProfile({
    fundCode: code,
    fundName: update.fundName !== undefined ? update.fundName : current?.fundName ?? null,
    fundCompany: update.fundCompany !== undefined ? update.fundCompany : current?.fundCompany ?? null,
    custodian: update.custodian !== undefined ? update.custodian : current?.custodian ?? null,
    manager: update.manager !== undefined ? update.manager : current?.manager ?? null,
    navDateOffset: update.navDateOffset ?? current?.navDateOffset ?? 0,
  });
}

/**
 * Persist the binary offset derived from the latest fetched NAV date.
 */
export async function syncFundNavDateOffsetFromLatestNav(params: {
  fundCode: string;
  lastNavDate: Date | string;
  now?: Date;
  tradingCalendar?: string | null;
}) {
  const code = params.fundCode.trim();
  if (!/^\d{6}$/.test(code)) throw new Error("fundCode must be a six-digit fund code.");
  const offset = deriveFundNavDateOffset(
    params.lastNavDate,
    params.now,
    params.tradingCalendar ?? "cn_fund",
  );
  return upsertFundProfileOffset(code, offset);
}

/**
 * Persist offsets for a batch of latest NAV records without coupling this
 * profile module to the NAV cache implementation.
 */
export async function syncFundNavDateOffsetsFromLatestNavs(
  latestNavs: Iterable<{ fundCode: string; navDate: Date | string; name?: string | null }>,
  now: Date = new Date(),
) {
  const uniqueNavs = new Map<string, { navDate: Date | string; name?: string | null }>();
  for (const latestNav of latestNavs) {
    const code = latestNav.fundCode.trim();
    if (/^\d{6}$/.test(code)) uniqueNavs.set(code, { navDate: latestNav.navDate, name: latestNav.name });
  }
  await Promise.all(
    Array.from(uniqueNavs, ([fundCode, latestNav]) =>
      syncFundNavDateOffsetFromLatestNav({
        fundCode,
        lastNavDate: latestNav.navDate,
        now,
        tradingCalendar: fundTradingCalendarForName(latestNav.name),
      }),
    ),
  );
}

async function upsertFetchedFundProfile(params: {
  fundCode: string;
  fundName: string | null;
  fundCompany: string | null;
  custodian: string | null;
  manager: string | null;
}) {
  const prisma = await getPrismaClient();
  const rows = await prisma.$queryRaw<FundProfileSqlRow[]>(Prisma.sql`
    INSERT INTO "FundProfile" (
      "fundCode",
      "fundName",
      "fundCompany",
      "custodian",
      "manager",
      "navDateOffset",
      "createdAt",
      "updatedAt"
    )
    VALUES (
      ${params.fundCode},
      ${params.fundName},
      ${params.fundCompany},
      ${params.custodian},
      ${params.manager},
      0,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT ("fundCode") DO UPDATE SET
      "fundName" = COALESCE(EXCLUDED."fundName", "FundProfile"."fundName"),
      "fundCompany" = COALESCE(EXCLUDED."fundCompany", "FundProfile"."fundCompany"),
      "custodian" = COALESCE(EXCLUDED."custodian", "FundProfile"."custodian"),
      "manager" = COALESCE(EXCLUDED."manager", "FundProfile"."manager"),
      "updatedAt" = CURRENT_TIMESTAMP
    RETURNING
      "fundCode",
      "fundName",
      "fundCompany",
      "custodian",
      "manager",
      "navDateOffset"
  `);
  return toFundProfileRecord(rows[0]!);
}

/**
 * Read a fund's profile from the FundProfile table.
 */
export async function getFundProfile(fundCode: string): Promise<FundProfileRecord | null> {
  const code = fundCode.trim();
  if (!/^\d{6}$/.test(code)) return null;
  const row = await readFundProfileRow(code);
  return row ? toFundProfileRecord(row) : null;
}

/** Read fund-level profiles for multiple fund codes in one query. */
export async function getFundProfiles(fundCodes: Iterable<string>): Promise<FundProfileRecord[]> {
  const codes = Array.from(new Set(Array.from(fundCodes).map((code) => code.trim()).filter((code) => /^\d{6}$/.test(code))));
  if (codes.length === 0) return [];
  const prisma = await getPrismaClient();
  const rows = await prisma.$queryRaw<FundProfileSqlRow[]>(Prisma.sql`
    ${FUND_PROFILE_SELECT}
    WHERE "fundCode" IN (${Prisma.join(codes)})
  `);
  return rows.map(toFundProfileRecord);
}

/** Return a usable display name unless the stored name is blank or just the code. */
export function normalizeFundDisplayName(fundCode: string, fundName: string | null | undefined) {
  const code = fundCode.trim();
  const name = String(fundName ?? "").trim();
  return name && name !== code ? name : null;
}

/** Read authoritative fund names from FundProfile for multiple codes. */
export async function getFundProfileNameMap(fundCodes: Iterable<string>): Promise<Map<string, string>> {
  const profiles = await getFundProfiles(fundCodes);
  const map = new Map<string, string>();
  for (const profile of profiles) {
    const name = normalizeFundDisplayName(profile.fundCode, profile.fundName);
    if (name) map.set(profile.fundCode, name);
  }
  return map;
}

/** Ensure that a valid fund code has a FundProfile row before external lookup. */
export async function ensureFundProfileRecord(fundCode: string): Promise<FundProfileRecord | null> {
  const code = fundCode.trim();
  if (!/^\d{6}$/.test(code)) return null;
  const existing = await getFundProfile(code);
  if (existing) return existing;

  const prisma = await getPrismaClient();
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "FundProfile" (
      "fundCode",
      "fundName",
      "fundCompany",
      "custodian",
      "manager",
      "navDateOffset",
      "createdAt",
      "updatedAt"
    )
    VALUES (${code}, NULL, NULL, NULL, NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT ("fundCode") DO NOTHING
  `);
  return getFundProfile(code);
}

/**
 * Read the configured NAV date offsets for multiple fund codes in one query.
 */
export async function getFundNavDateOffsets(fundCodes: Iterable<string>) {
  const codes = Array.from(new Set(Array.from(fundCodes).map((code) => code.trim()).filter((code) => /^\d{6}$/.test(code))));
  if (codes.length === 0) return new Map<string, number>();
  const prisma = await getPrismaClient();
  const rows = await prisma.$queryRaw<Array<{ fundCode: string; navDateOffset: number | bigint | null }>>(Prisma.sql`
    SELECT "fundCode", "navDateOffset"
    FROM "FundProfile"
    WHERE "fundCode" IN (${Prisma.join(codes)})
  `);
  return new Map(rows.map((row) => [row.fundCode, normalizeNavDateOffset(row.navDateOffset)]));
}

/**
 * Set a fund's NAV date offset used by investment profit statistics.
 */
export async function setFundNavDateOffset(fundCode: string, offset: number) {
  const code = fundCode.trim();
  if (!/^\d{6}$/.test(code)) throw new Error("fundCode must be a six-digit fund code.");
  if (offset !== 0 && offset !== 1) {
    throw new Error("navDateOffset must be 0 or 1.");
  }
  return upsertFundProfileOffset(code, offset);
}

/**
 * Resolve a fund's display name by fund code.
 *
 * This is the single entry point for "fund code → fund name" lookups across
 * the app. Resolution order:
 *   1. FundProfile table (fund-level cache, includes fund company).
 *   2. Fund company / fund detail API (queryFundProfile), which also writes
 *      the profile back to FundProfile so later lookups hit the cache.
 *   3. Fall back to the lightweight identity API (queryFundIdentity) when the
 *      profile page yields no name.
 *
 * Returns the resolved name, or null when the code is invalid or unresolvable.
 */
export async function resolveFundName(
  fundCode: string,
  context?: FundProfileContext,
): Promise<string | null> {
  const code = fundCode.trim();
  if (!/^\d{6}$/.test(code)) return null;

  const cached = await ensureFundProfileRecord(code);
  if (cached) {
    await syncFundCompanyInstitution(cached, context);
    if (cached.fundName) return cached.fundName;
  }

  const profile = await ensureFundProfile(code, context);
  if (profile?.fundName) return profile.fundName;

  const identity = await queryFundIdentity(code);
  if (identity?.name) return identity.name;

  return null;
}

/**
 * Ensure a fund's profile exists in the FundProfile table.
 *
 * - If the profile is already cached, return it without any network call.
 * - Otherwise fetch it from the fund overview page and upsert it.
 * - If the fetch fails, return null (callers should not treat this as fatal).
 */
export async function ensureFundProfile(
  fundCode: string,
  context?: FundProfileContext,
): Promise<FundProfileRecord | null> {
  const code = fundCode.trim();
  if (!/^\d{6}$/.test(code)) return null;

  const cached = await getFundProfile(code);
  if (hasFetchedFundProfileData(cached)) {
    await syncFundCompanyInstitution(cached!, context);
    return cached;
  }

  await ensureFundProfileRecord(code);
  const fetched = await queryFundProfile(code);
  if (!fetched) return null;

  const profile = await upsertFetchedFundProfile({
    fundCode: code,
    fundName: fetched.name ?? null,
    fundCompany: fetched.fundCompany ?? null,
    custodian: fetched.custodian ?? null,
    manager: fetched.manager ?? null,
  });
  await syncFundCompanyInstitution(profile, context);
  return profile;
}

/**
 * Fetch a fund profile from the external source and merge the returned fields
 * into the fund-level profile cache without changing the configured NAV offset.
 */
export async function refreshFundProfile(
  fundCode: string,
  context?: FundProfileContext,
): Promise<FundProfileRecord | null> {
  const code = fundCode.trim();
  if (!/^\d{6}$/.test(code)) return null;

  const fetched = await queryFundProfile(code);
  if (!fetched) return null;

  const profile = await upsertFetchedFundProfile({
    fundCode: code,
    fundName: fetched.name ?? null,
    fundCompany: fetched.fundCompany ?? null,
    custodian: fetched.custodian ?? null,
    manager: fetched.manager ?? null,
  });
  await syncFundCompanyInstitution(profile, context);
  return profile;
}
