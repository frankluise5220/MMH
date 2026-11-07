import { prisma } from "@/lib/db/prisma";

/**
 * 内置贵金属品种 / 单位，口径与外汇一致：一小套系统内置 + 用户按账簿自建。
 *
 * 这里不写成纯前端常量，而是首次读字典时补进库里（householdId=null / isSystem=true）：
 * TxRecord.metalTypeId、metalUnitId 是外键，表单选中的必须是真实存在的行。
 * ID 固定，备份恢复、跨账簿共享后历史记录仍能对上。
 */
const SYSTEM_METAL_TYPES = [
  { id: "pmt-system-xau", code: "XAU", name: "黄金", shortName: "Au", sortOrder: 1 },
  { id: "pmt-system-xag", code: "XAG", name: "白银", shortName: "Ag", sortOrder: 2 },
  { id: "pmt-system-xpt", code: "XPT", name: "铂金", shortName: "Pt", sortOrder: 3 },
  { id: "pmt-system-xpd", code: "XPD", name: "钯金", shortName: "Pd", sortOrder: 4 },
] as const;

const SYSTEM_METAL_UNITS = [
  { id: "pmu-system-g", code: "G", name: "克", symbol: "g", decimals: 3, sortOrder: 1 },
  { id: "pmu-system-oz", code: "OZ", name: "盎司", symbol: "oz", decimals: 3, sortOrder: 2 },
  { id: "pmu-system-kg", code: "KG", name: "千克", symbol: "kg", decimals: 3, sortOrder: 3 },
] as const;

function isUniqueViolation(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "P2002");
}

/**
 * 每次读字典都按 id / code 自检一遍，而不是只在进程启动时补一次：
 * 恢复备份、恢复出厂设置、手工删库之后都会在下次读取时自愈。
 */
async function ensureSystemDictionaries() {
  const [typeRows, unitRows] = await Promise.all([
    prisma.preciousMetalType.findMany({ where: { householdId: null }, select: { id: true, code: true } }),
    prisma.preciousMetalUnit.findMany({ where: { householdId: null }, select: { id: true, code: true } }),
  ]);
  // householdId 为 NULL 时 Postgres 的唯一约束不生效，所以按 id / code 自行去重。
  const hasType = (id: string, code: string) => typeRows.some((row) => row.id === id || row.code === code);
  const hasUnit = (id: string, code: string) => unitRows.some((row) => row.id === id || row.code === code);

  for (const item of SYSTEM_METAL_TYPES) {
    if (hasType(item.id, item.code)) continue;
    try {
      await prisma.preciousMetalType.create({
        data: {
          id: item.id,
          code: item.code,
          name: item.name,
          shortName: item.shortName,
          sortOrder: item.sortOrder,
          isSystem: true,
          isActive: true,
          householdId: null,
        },
      });
    } catch (error) {
      // 多进程同时初始化：别人已插入就忽略，其余错误照常抛出。
      if (!isUniqueViolation(error)) throw error;
    }
  }
  for (const item of SYSTEM_METAL_UNITS) {
    if (hasUnit(item.id, item.code)) continue;
    try {
      await prisma.preciousMetalUnit.create({
        data: {
          id: item.id,
          code: item.code,
          name: item.name,
          symbol: item.symbol,
          decimals: item.decimals,
          sortOrder: item.sortOrder,
          isSystem: true,
          isActive: true,
          householdId: null,
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
}

type MetalTypeRow = {
  id: string;
  code: string;
  name: string;
  shortName: string | null;
  sortOrder: number;
  isSystem: boolean;
  householdId: string | null;
};

type MetalUnitRow = {
  id: string;
  code: string;
  name: string;
  symbol: string | null;
  decimals: number;
  sortOrder: number;
  isSystem: boolean;
  householdId: string | null;
};

function dictionarySort<T extends { householdId: string | null; sortOrder: number; name: string; code: string }>(
  householdId: string,
) {
  return (a: T, b: T) => {
    const aScope = a.householdId === householdId ? 0 : 1;
    const bScope = b.householdId === householdId ? 0 : 1;
    if (aScope !== bScope) return aScope - bScope;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    const byName = a.name.localeCompare(b.name, "zh-Hans-CN");
    return byName || a.code.localeCompare(b.code);
  };
}

export async function listPreciousMetalDictionaries(householdId: string) {
  await ensureSystemDictionaries();
  const [typeRows, unitRows] = await Promise.all([
    prisma.preciousMetalType.findMany({
      where: {
        isActive: true,
        OR: [{ householdId }, { householdId: null }],
      },
      select: {
        id: true,
        code: true,
        name: true,
        shortName: true,
        sortOrder: true,
        isSystem: true,
        householdId: true,
      },
    }),
    prisma.preciousMetalUnit.findMany({
      where: {
        isActive: true,
        OR: [{ householdId }, { householdId: null }],
      },
      select: {
        id: true,
        code: true,
        name: true,
        symbol: true,
        decimals: true,
        sortOrder: true,
        isSystem: true,
        householdId: true,
      },
    }),
  ]);

  const types = (typeRows as MetalTypeRow[]).sort(dictionarySort(householdId)).map((item) => ({
    id: item.id,
    code: item.code,
    name: item.name,
    shortName: item.shortName,
  }));
  const units = (unitRows as MetalUnitRow[]).sort(dictionarySort(householdId)).map((item) => ({
    id: item.id,
    code: item.code,
    name: item.name,
    symbol: item.symbol,
    decimals: item.decimals,
  }));

  return { types, units };
}

export type PreciousMetalDictionaryItem =
  | { kind: "type"; id: string; code: string; name: string; shortName: string | null }
  | { kind: "unit"; id: string; code: string; name: string; symbol: string | null; decimals: number };

export class PreciousMetalDictionaryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type CreateDictionaryBody = {
  kind?: unknown;
  code?: unknown;
  name?: unknown;
  shortName?: unknown;
  symbol?: unknown;
  decimals?: unknown;
};

function text(value: unknown) {
  return String(value ?? "").trim();
}

/**
 * 新建本账簿的贵金属品种 / 单位（与「新增货币」一样：内置清单只读，自建行按 household 隔离）。
 * 系统内置行与本账簿已有行都参与查重，避免出现两个「黄金」。
 */
export async function createPreciousMetalDictionary(
  householdId: string,
  body: CreateDictionaryBody,
): Promise<PreciousMetalDictionaryItem> {
  await ensureSystemDictionaries();
  const kind = text(body.kind);
  if (kind !== "type" && kind !== "unit") {
    throw new PreciousMetalDictionaryError("INVALID_KIND", "字典类型不正确");
  }
  const name = text(body.name);
  if (!name) throw new PreciousMetalDictionaryError("INVALID_NAME", "请填写名称");
  const nameLimit = kind === "type" ? 32 : 16;
  if (name.length > nameLimit) {
    throw new PreciousMetalDictionaryError("INVALID_NAME", `名称不能超过 ${nameLimit} 个字`);
  }
  // 代码可以留空：用户未必知道 XAU / AU9999 这类代码，直接用名称当唯一键。
  const code = (text(body.code) || text(body.symbol) || name).toUpperCase();
  if (code.length > 24) throw new PreciousMetalDictionaryError("INVALID_CODE", "代码过长");

  const scope = [{ householdId }, { householdId: null }];
  const clashWhere = {
    AND: [{ OR: scope }, { OR: [{ code }, { name }] }],
  };

  if (kind === "type") {
    const clash = await prisma.preciousMetalType.findFirst({ where: clashWhere, select: { id: true } });
    if (clash) {
      throw new PreciousMetalDictionaryError("DUPLICATE", `已存在名称为「${name}」或代码为 ${code} 的贵金属品种`);
    }
    const shortName = text(body.shortName) || null;
    const created = await prisma.preciousMetalType.create({
      data: {
        householdId,
        code,
        name,
        shortName,
        sortOrder: 100,
        isSystem: false,
        isActive: true,
      },
    });
    return { kind, id: created.id, code: created.code, name: created.name, shortName };
  }

  const decimalsRaw = body.decimals == null || text(body.decimals) === "" ? 3 : Number(body.decimals);
  const decimals = Number.isInteger(decimalsRaw) && decimalsRaw >= 0 && decimalsRaw <= 6 ? decimalsRaw : 3;
  const clash = await prisma.preciousMetalUnit.findFirst({ where: clashWhere, select: { id: true } });
  if (clash) {
    throw new PreciousMetalDictionaryError("DUPLICATE", `已存在名称为「${name}」或代码为 ${code} 的贵金属单位`);
  }
  const symbol = text(body.symbol) || null;
  const created = await prisma.preciousMetalUnit.create({
    data: {
      householdId,
      code,
      name,
      symbol,
      decimals,
      sortOrder: 100,
      isSystem: false,
      isActive: true,
    },
  });
  return { kind, id: created.id, code: created.code, name: created.name, symbol, decimals };
}
