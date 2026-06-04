import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";

export async function GET() {
  const caches = await prisma.fundNavCache.findMany({
    orderBy: [{ fundCode: "asc" }, { navDate: "asc" }],
  });
  return NextResponse.json({
    count: caches.length,
    records: caches.map(c => ({
      fundCode: c.fundCode,
      navDate: c.navDate.toISOString(),
      nav: toNumber(c.nav),
    })),
  });
}