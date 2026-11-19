/**
 * 电子钱包 → 货币基金的「绑定区间」读写（2026-11-19 用户要求）。
 *
 * 为什么要一张表：同一只钱包可能在不同时间绑不同的货基（余额宝换成长江乐享等），
 * 只在 Account 上存一个 code 会把历史覆盖掉，重算历史时也没法知道某天该用哪只基金的
 * 万份收益。所以每次绑定落一段（fundCode + startDate + endDate），换绑只关旧段、加新段。
 *
 * Account.linkedFundCode / linkedFundStartDate 继续保留，作为「当前生效段」的冗余快照：
 * 账户列表、明细页过滤（hideWalletLinkedLegs）都读它，避免把所有读路径都改成 join。
 * 它只能由本模块同步，其它地方不要手写这两个字段。
 */

import { Prisma } from "@prisma/client";
import { parseDateInputToUtc } from "@/lib/date-utils";
import { prisma } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { shiftYmd } from "@/lib/fund/moneyFundYield";
import { utcDayKey } from "@/lib/server/interest-accrual";
import { TRANSACTION_SOURCE_MONEY_INCOME } from "@/lib/transaction-semantics";

type Tx = Prisma.TransactionClient;

export type WalletLinkedFundSegment = {
  id: string;
  accountId: string;
  fundCode: string;
  fundName: string | null;
  /** YYYY-MM-DD（含）。 */
  startDate: string;
  /** YYYY-MM-DD（含）；null = 当前生效。 */
  endDate: string | null;
  note: string | null;
};

/** 服务端可判定的绑定错误；route 层映射成 4xx + code。 */
export class WalletLinkedFundError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "WalletLinkedFundError";
  }
}

export const WALLET_LINKED_FUND_ERROR = {
  accountMissing: "ACCOUNT_LINKED_FUND_ACCOUNT_MISSING",
  kind: "ACCOUNT_LINKED_FUND_KIND",
  code: "ACCOUNT_LINKED_FUND_CODE",
  startDate: "ACCOUNT_LINKED_FUND_START_DATE",
  overlap: "ACCOUNT_LINKED_FUND_OVERLAP",
  segmentMissing: "ACCOUNT_LINKED_FUND_SEGMENT_MISSING",
  endDate: "ACCOUNT_LINKED_FUND_END_DATE",
} as const;

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function toSegment(row: {
  id: string;
  accountId: string;
  fundCode: string;
  fundName: string | null;
  startDate: Date;
  endDate: Date | null;
  note: string | null;
}): WalletLinkedFundSegment {
  return {
    id: row.id,
    accountId: row.accountId,
    fundCode: row.fundCode,
    fundName: row.fundName,
    startDate: utcDayKey(row.startDate),
    endDate: row.endDate ? utcDayKey(row.endDate) : null,
    note: row.note,
  };
}

/** 某只钱包的全部绑定段（按起始日升序）。 */
export async function listWalletLinkedFundSegments(accountId: string): Promise<WalletLinkedFundSegment[]> {
  const rows = await prisma.walletLinkedFund.findMany({
    where: { accountId },
    orderBy: [{ startDate: "asc" }, { createdAt: "asc" }],
  });
  return rows.map(toSegment);
}

/**
 * 段列表 + 当前生效段，一次查询拿全（弹窗打开时只需要这一下）。
 *
 * 这两份数据本来是同一条 SQL：先按账户捞全部段，当前段就是其中 endDate 为空、
 * startDate 最大的那条。分成两次查询等于白多一次往返（数据库在远端，一次 10ms+）。
 */
export async function loadWalletLinkedFundOverview(accountId: string): Promise<{
  segments: WalletLinkedFundSegment[];
  current: WalletLinkedFundSegment | null;
}> {
  const segments = await listWalletLinkedFundSegments(accountId);
  const current = [...segments].reverse().find((segment) => !segment.endDate) ?? null;
  return { segments, current };
}

/** 当前生效段（endDate 为空）；没有则返回 null。 */
export async function currentWalletLinkedFundSegment(accountId: string): Promise<WalletLinkedFundSegment | null> {
  const row = await prisma.walletLinkedFund.findFirst({
    where: { accountId, endDate: null },
    orderBy: { startDate: "desc" },
  });
  return row ? toSegment(row) : null;
}

/**
 * 把 Account 上的快照字段对齐到当前生效段（事务内调用）。
 * 解绑/关闭最后一段后快照清空，明细页就不再隐藏搬运行、也不再计息。
 */
async function syncAccountSnapshot(tx: Tx, accountId: string) {
  const open = await tx.walletLinkedFund.findFirst({
    where: { accountId, endDate: null },
    orderBy: { startDate: "desc" },
  });
  await tx.account.update({
    where: { id: accountId },
    data: {
      linkedFundCode: open?.fundCode ?? null,
      linkedFundStartDate: open?.startDate ?? null,
    },
  });
}

/** 绑定（含换绑）：关闭当前生效段，写入新段，并同步 Account 快照。 */
export async function bindWalletLinkedFundSegment(params: {
  householdId: string;
  accountId: string;
  fundCode: string;
  fundName?: string | null;
  /** YYYY-MM-DD。 */
  startDate: string;
  note?: string | null;
}): Promise<WalletLinkedFundSegment> {
  const fundCode = params.fundCode.trim();
  if (!/^\d{6}$/.test(fundCode)) {
    throw new WalletLinkedFundError(WALLET_LINKED_FUND_ERROR.code, "货币基金代码必须是 6 位数字");
  }
  const startDate = params.startDate.trim();
  if (!YMD_RE.test(startDate)) {
    throw new WalletLinkedFundError(WALLET_LINKED_FUND_ERROR.startDate, "绑定起始日格式必须是 YYYY-MM-DD");
  }
  const start = parseDateInputToUtc(startDate);
  if (!start) {
    throw new WalletLinkedFundError(WALLET_LINKED_FUND_ERROR.startDate, "绑定起始日无效");
  }

  return prisma.$transaction(async (tx) => {
    const account = await tx.account.findFirst({
      where: { id: params.accountId, householdId: params.householdId },
      select: { id: true, kind: true },
    });
    if (!account) {
      throw new WalletLinkedFundError(WALLET_LINKED_FUND_ERROR.accountMissing, "账户不存在");
    }
    if (account.kind !== "ewallet") {
      throw new WalletLinkedFundError(WALLET_LINKED_FUND_ERROR.kind, "只有电子钱包账户可以挂货币基金");
    }

    const open = await tx.walletLinkedFund.findFirst({
      where: { accountId: params.accountId, endDate: null },
      orderBy: { startDate: "desc" },
    });
    // 换绑只能往后接：新段起始日必须晚于当前段起始日，否则历史区间会重叠。
    if (open && start <= open.startDate) {
      throw new WalletLinkedFundError(
        WALLET_LINKED_FUND_ERROR.overlap,
        `新绑定起始日必须晚于当前绑定（${utcDayKey(open.startDate)}）`,
      );
    }
    if (open) {
      const endDate = parseDateInputToUtc(shiftYmd(utcDayKey(start), -1));
      await tx.walletLinkedFund.update({ where: { id: open.id }, data: { endDate } });
    }

    const created = await tx.walletLinkedFund.create({
      data: {
        householdId: params.householdId,
        accountId: params.accountId,
        fundCode,
        fundName: params.fundName?.trim() || null,
        startDate: start,
        note: params.note?.trim() || null,
      },
    });
    await syncAccountSnapshot(tx, params.accountId);
    return toSegment(created);
  });
}

/**
 * 关闭某段（解绑）：默认关当前生效段；不传 endDate 时用「昨天」——
 * 今天的收益已经算过就留着，从明天起不再计息。
 */
export async function closeWalletLinkedFundSegment(params: {
  householdId: string;
  accountId: string;
  segmentId?: string | null;
  /** YYYY-MM-DD（含，最后一天计息）。 */
  endDate?: string | null;
  todayYmd: string;
}): Promise<{ segment: WalletLinkedFundSegment | null; closed: number }> {
  const endDateYmd = params.endDate?.trim()
    || shiftYmd(params.todayYmd, -1);
  if (!YMD_RE.test(endDateYmd)) {
    throw new WalletLinkedFundError(WALLET_LINKED_FUND_ERROR.endDate, "结束日格式必须是 YYYY-MM-DD");
  }
  const endDate = parseDateInputToUtc(endDateYmd);
  if (!endDate) {
    throw new WalletLinkedFundError(WALLET_LINKED_FUND_ERROR.endDate, "结束日无效");
  }

  return prisma.$transaction(async (tx) => {
    const target = params.segmentId
      ? await tx.walletLinkedFund.findFirst({
        where: { id: params.segmentId, accountId: params.accountId, householdId: params.householdId },
      })
      : await tx.walletLinkedFund.findFirst({
        where: { accountId: params.accountId, householdId: params.householdId, endDate: null },
        orderBy: { startDate: "desc" },
      });
    if (!target) {
      throw new WalletLinkedFundError(WALLET_LINKED_FUND_ERROR.segmentMissing, "没有可解绑的绑定记录");
    }
    if (endDate < target.startDate) {
      throw new WalletLinkedFundError(
        WALLET_LINKED_FUND_ERROR.endDate,
        `结束日不能早于该段起始日（${utcDayKey(target.startDate)}）`,
      );
    }
    const updated = await tx.walletLinkedFund.update({ where: { id: target.id }, data: { endDate } });
    await syncAccountSnapshot(tx, params.accountId);
    return { segment: toSegment(updated), closed: 1 };
  });
}

/**
 * 保存某一段：改计息日/退出日/基金代码，或补录一段新的历史（2026-11-19 用户要求：
 * 「允许修改计算日期、退出日期、货基代码，下面还要有空行允许新增」）。
 *
 * 与 `bindWalletLinkedFundSegment` 的区别：这里不「关旧段」，就是直接写一段记录
 * （补历史、纠正误绑），所以必须自己保证区间不重叠——两个「生效中」的段本质上是
 * 两段都开到无穷远，同样被重叠校验挡住。
 *
 * 改过的段里旧代码/旧日期的收益行会一起删掉，交给调用方重新结转，否则同一段会同时
 * 留着两只基金的收益。
 */
export async function saveWalletLinkedFundSegment(params: {
  householdId: string;
  accountId: string;
  /** 有值 = 改这一段；空 = 新增一段。 */
  segmentId?: string | null;
  /** YYYY-MM-DD（含）。 */
  startDate: string;
  /** YYYY-MM-DD（含）；空 = 该段仍然生效。 */
  endDate?: string | null;
  fundCode: string;
  fundName?: string | null;
}): Promise<{ segment: WalletLinkedFundSegment; removedIncome: number; created: boolean }> {
  const fundCode = params.fundCode.trim();
  if (!/^\d{6}$/.test(fundCode)) {
    throw new WalletLinkedFundError(WALLET_LINKED_FUND_ERROR.code, "货币基金代码必须是 6 位数字");
  }
  const startDateYmd = params.startDate.trim();
  if (!YMD_RE.test(startDateYmd)) {
    throw new WalletLinkedFundError(WALLET_LINKED_FUND_ERROR.startDate, "计息起始日格式必须是 YYYY-MM-DD");
  }
  const start = parseDateInputToUtc(startDateYmd);
  if (!start) {
    throw new WalletLinkedFundError(WALLET_LINKED_FUND_ERROR.startDate, "计息起始日无效");
  }
  const endDateYmd = (params.endDate ?? "").trim();
  if (endDateYmd && !YMD_RE.test(endDateYmd)) {
    throw new WalletLinkedFundError(WALLET_LINKED_FUND_ERROR.endDate, "退出日期格式必须是 YYYY-MM-DD");
  }
  const end = endDateYmd ? parseDateInputToUtc(endDateYmd) : null;
  if (endDateYmd && !end) {
    throw new WalletLinkedFundError(WALLET_LINKED_FUND_ERROR.endDate, "退出日期无效");
  }
  if (end && end < start) {
    throw new WalletLinkedFundError(
      WALLET_LINKED_FUND_ERROR.endDate,
      `退出日期不能早于计息起始日（${startDateYmd}）`,
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    const account = await tx.account.findFirst({
      where: { id: params.accountId, householdId: params.householdId },
      select: { id: true, kind: true },
    });
    if (!account) {
      throw new WalletLinkedFundError(WALLET_LINKED_FUND_ERROR.accountMissing, "账户不存在");
    }
    if (account.kind !== "ewallet") {
      throw new WalletLinkedFundError(WALLET_LINKED_FUND_ERROR.kind, "只有电子钱包账户可以挂货币基金");
    }

    const target = params.segmentId
      ? await tx.walletLinkedFund.findFirst({
        where: { id: params.segmentId, accountId: params.accountId, householdId: params.householdId },
      })
      : null;
    if (params.segmentId && !target) {
      throw new WalletLinkedFundError(WALLET_LINKED_FUND_ERROR.segmentMissing, "绑定记录不存在");
    }

    const siblings = await tx.walletLinkedFund.findMany({
      where: {
        accountId: params.accountId,
        householdId: params.householdId,
        ...(target ? { id: { not: target.id } } : {}),
      },
      orderBy: { startDate: "asc" },
    });
    const startMs = start.getTime();
    const endMs = end ? end.getTime() : Number.POSITIVE_INFINITY;
    for (const sibling of siblings) {
      const siblingStart = sibling.startDate.getTime();
      const siblingEnd = sibling.endDate ? sibling.endDate.getTime() : Number.POSITIVE_INFINITY;
      if (startMs <= siblingEnd && siblingStart <= endMs) {
        throw new WalletLinkedFundError(
          WALLET_LINKED_FUND_ERROR.overlap,
          `与 ${utcDayKey(sibling.startDate)} 起的那段重叠`,
        );
      }
    }

    // 改段会让旧的收益行与新的区间/代码对不上：先清掉，调用方重算时按新段重建。
    let removedIncome = 0;
    if (target) {
      const oldEndKey = target.endDate ? utcDayKey(target.endDate) : null;
      const changed = utcDayKey(target.startDate) !== startDateYmd
        || oldEndKey !== (endDateYmd || null)
        || target.fundCode !== fundCode;
      if (changed) {
        const removed = await tx.txRecord.deleteMany({
          where: {
            accountId: params.accountId,
            source: TRANSACTION_SOURCE_MONEY_INCOME,
            fundCode: target.fundCode,
            date: {
              gte: target.startDate,
              ...(target.endDate ? { lte: target.endDate } : {}),
            },
          },
        });
        removedIncome = removed.count;
      }
    }

    const data = {
      fundCode,
      fundName: params.fundName?.trim() || null,
      startDate: start,
      endDate: end,
    };
    const saved = target
      ? await tx.walletLinkedFund.update({ where: { id: target.id }, data })
      : await tx.walletLinkedFund.create({
        data: {
          ...data,
          householdId: params.householdId,
          accountId: params.accountId,
        },
      });
    await syncAccountSnapshot(tx, params.accountId);
    return { segment: toSegment(saved), removedIncome, created: !target };
  });

  if (result.removedIncome > 0) {
    await recalcAndSaveAccountBalance(params.accountId).catch((error) => {
      logger.warn(
        `Wallet balance recalc after saving linked-fund segment failed: ${params.accountId}`,
        "wallet-linked-fund-periods",
        error,
      );
    });
  }
  return result;
}

/** 某段命中的收益行条件：同一钱包 + 同一只基金 + 该段时间内。 */
function segmentIncomeWhere(accountId: string, segment: {
  fundCode: string;
  startDate: Date;
  endDate: Date | null;
}) {
  return {
    accountId,
    source: TRANSACTION_SOURCE_MONEY_INCOME,
    fundCode: segment.fundCode,
    date: {
      gte: segment.startDate,
      ...(segment.endDate ? { lte: segment.endDate } : {}),
    },
  };
}

/**
 * 删除绑定前先看清「这段已经生成了多少收益」（2026-11-19 用户要求：删除绑定时要问
 * 是删除还是保留已生成的收益，用户得先知道会动到什么）。
 */
export async function summarizeWalletLinkedFundIncome(params: {
  householdId: string;
  accountId: string;
  segmentId: string;
}): Promise<{ days: number; amount: number }> {
  const target = await prisma.walletLinkedFund.findFirst({
    where: { id: params.segmentId, accountId: params.accountId, householdId: params.householdId },
    select: { fundCode: true, startDate: true, endDate: true },
  });
  if (!target) {
    throw new WalletLinkedFundError(WALLET_LINKED_FUND_ERROR.segmentMissing, "绑定记录不存在");
  }
  const summary = await prisma.txRecord.aggregate({
    where: segmentIncomeWhere(params.accountId, target),
    _count: { _all: true },
    _sum: { amount: true },
  });
  return { days: summary._count._all, amount: Number(summary._sum.amount ?? 0) };
}

/**
 * 删除某段（纠正误绑）：默认连同该段期间的收益行一起清掉，再把钱包余额重新折一次。
 *
 * `keepIncome` = 只删这张绑定记录、把已经记进流水的收益留着（用户明确要保留收益时用）：
 * 那些收益是真实到账过的钱，删掉余额就少了一块，所以必须是用户选择而不是默认。
 *
 * 删掉当前生效段等于「这段从来没绑过」：快照随之清空（`syncAccountSnapshot`），
 * 之后不再计息。由于删了真实流水，余额必须在事务提交后重折，不能只靠下次触发自愈。
 */
export async function deleteWalletLinkedFundSegment(params: {
  householdId: string;
  accountId: string;
  segmentId: string;
  /** true = 保留已生成的收益流水，只删绑定。 */
  keepIncome?: boolean;
}): Promise<{ segment: WalletLinkedFundSegment; removedIncome: number; keptIncome: number }> {
  const keepIncome = params.keepIncome === true;
  const result = await prisma.$transaction(async (tx) => {
    const target = await tx.walletLinkedFund.findFirst({
      where: { id: params.segmentId, accountId: params.accountId, householdId: params.householdId },
    });
    if (!target) {
      throw new WalletLinkedFundError(WALLET_LINKED_FUND_ERROR.segmentMissing, "绑定记录不存在");
    }
    const where = segmentIncomeWhere(params.accountId, target);
    let removedIncome = 0;
    let keptIncome = 0;
    if (keepIncome) {
      keptIncome = await tx.txRecord.count({ where });
    } else {
      const removed = await tx.txRecord.deleteMany({ where });
      removedIncome = removed.count;
    }
    await tx.walletLinkedFund.delete({ where: { id: target.id } });
    await syncAccountSnapshot(tx, params.accountId);
    return { segment: toSegment(target), removedIncome, keptIncome };
  });

  if (result.removedIncome > 0) {
    await recalcAndSaveAccountBalance(params.accountId).catch((error) => {
      logger.warn(
        `Wallet balance recalc after deleting linked-fund segment failed: ${params.accountId}`,
        "wallet-linked-fund-periods",
        error,
      );
    });
  }
  return result;
}
