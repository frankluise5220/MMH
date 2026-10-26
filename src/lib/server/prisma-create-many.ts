import { Prisma } from "@prisma/client";

type CreateManyDelegate<T> = {
  createMany(args: { data: T[] } | { data: T[]; skipDuplicates: true }): Promise<{ count: number }>;
  create(args: { data: T }): Promise<unknown>;
};

/**
 * 每条 SQL 的行数上限。恢复时这些数组可以有几万行，一条巨大的 INSERT 既撑爆绑定参数，
 * 又会在 SQLite 上把事件循环按死好几分钟。
 */
const CREATE_MANY_CHUNK_SIZE = 500;

function isSqliteDatabaseUrl() {
  const url = process.env.DATABASE_URL ?? "";
  return url === ":memory:" || url.startsWith("file:");
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function yieldToEventLoop() {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function chunk<T>(data: T[], size: number) {
  if (data.length <= size) return [data];
  const chunks: T[][] = [];
  for (let index = 0; index < data.length; index += size) {
    chunks.push(data.slice(index, index + size));
  }
  return chunks;
}

/**
 * 逐行 create + 吞掉唯一约束冲突。
 *
 * SQLite 不支持 `createMany({ skipDuplicates: true })`，只能用这个兜底；但恢复时整张表刚被
 * 清空，冲突本来是极少数，所以只在整批 INSERT 撞到 P2002 之后才退化成逐行写。
 */
async function createSkippingDuplicatesRowByRow<T>(delegate: CreateManyDelegate<T>, items: T[]) {
  let count = 0;
  for (const item of items) {
    try {
      await delegate.create({ data: item });
      count += 1;
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
    }
  }
  return count;
}

export async function createManySkipDuplicatesCompat<T>(
  delegate: CreateManyDelegate<T>,
  data: T[],
): Promise<{ count: number }> {
  if (data.length === 0) return { count: 0 };
  const sqlite = isSqliteDatabaseUrl();
  let count = 0;

  for (const batch of chunk(data, CREATE_MANY_CHUNK_SIZE)) {
    if (!sqlite) {
      const result = await delegate.createMany({ data: batch, skipDuplicates: true } as {
        data: T[];
        skipDuplicates: true;
      });
      count += result.count;
      await yieldToEventLoop();
      continue;
    }

    // SQLite：先整批写。成功就等价于 skipDuplicates（恢复前已清空，本来就不该有冲突）；
    // 撞到唯一约束再把这一批退回逐行，代价被限制在 500 行以内。
    try {
      const result = await delegate.createMany({ data: batch });
      count += result.count;
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      count += await createSkippingDuplicatesRowByRow(delegate, batch);
    }
    await yieldToEventLoop();
  }

  return { count };
}
