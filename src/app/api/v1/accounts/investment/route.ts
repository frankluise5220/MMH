import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";
import { getApiHouseholdScope } from "@/lib/server/api-auth";

export const runtime = "nodejs";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
  } as const;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export async function GET(req: Request) {
  let scope;
  try {
    scope = await getApiHouseholdScope(req);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Unauthorized" },
      { status: 401, headers: corsHeaders() }
    );
  }

  const accounts = await prisma.account.findMany({
    where: {
      ...scope.hidFilter,
      kind: "investment",
      isActive: true,
    },
    select: {
      id: true,
      name: true,
      balance: true,
      investProductType: true,
      currency: true,
      Institution: { select: { name: true } },
    },
    orderBy: [{ name: "asc" }],
  });

  return NextResponse.json(
    {
      ok: true,
      accounts: accounts.map((account) => ({
        id: account.id,
        name: account.name,
        balance: toNumber(account.balance),
        investProductType: account.investProductType ?? "fund",
        currency: account.currency,
        institutionName: account.Institution?.name ?? "",
      })),
    },
    { headers: corsHeaders() }
  );
}
