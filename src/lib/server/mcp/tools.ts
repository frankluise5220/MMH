/**
 * MCP tool registry for MMH.
 *
 * Every definition here is the contract agents see: `description` carries the
 * caliber (what counts as a buy, which date basis, what is excluded) and
 * `inputSchema` is the JSON Schema the model reads to build arguments. Keep
 * both in sync with `docs/mcp-agent-api.md`.
 *
 * Tools dispatch to the *existing* route handlers rather than re-querying the
 * database, so an agent and the Web UI always produce the same number.
 */
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { GET as accountsGET } from "@/app/api/v1/accounts/route";
import { GET as categoryGET } from "@/app/api/v1/category/route";
import { GET as depositLotsGET } from "@/app/api/v1/deposit/lots/route";
import { GET as bondLotsGET } from "@/app/api/v1/bond/lots/route";
import { GET as shellDataGET } from "@/app/api/v1/fund/shell-data/route";
import { GET as statisticsGET } from "@/app/api/v1/statistics/route";
import {
  DELETE as txDetailDELETE,
  GET as txDetailGET,
  POST as txDetailPOST,
} from "@/app/api/v1/transactions/detail/route";
import { queryInvestmentFlow, type InvestmentFlowInput } from "@/lib/server/mcp/investment-flow";

export type McpToolContext = {
  /** Origin of the incoming MCP request, used to build internal URLs. */
  origin: string;
  /** Full Authorization header value, forwarded so inner handlers authenticate. */
  authorization: string;
  householdId: string;
  scope: "read" | "write";
};

export type McpTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Write tools are rejected when the Access Key scope is "read". */
  write: boolean;
  invoke: (args: Record<string, unknown>, ctx: McpToolContext) => Promise<unknown>;
};

type RouteHandler = (req: NextRequest) => Promise<Response>;

type CallInit = {
  method?: "GET" | "POST" | "DELETE";
  query?: Record<string, string | undefined>;
  body?: Record<string, unknown>;
};

/**
 * Invoke an existing route handler in-process with the caller's Access Key.
 *
 * Going through the real handler (instead of a new query) is what keeps agent
 * results identical to the Web UI: balances, statement months, position
 * recomputation and undo snapshots all run exactly as they normally would.
 */
async function callRoute(
  handler: RouteHandler,
  ctx: McpToolContext,
  path: string,
  init: CallInit = {},
): Promise<unknown> {
  const url = new URL(path, ctx.origin);
  for (const [key, value] of Object.entries(init.query ?? {})) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  }

  const headers = new Headers({ authorization: ctx.authorization });
  if (init.body) headers.set("content-type", "application/json");

  const req = new NextRequest(url, {
    method: init.method ?? "GET",
    headers,
    body: init.body ? JSON.stringify(init.body) : undefined,
  });

  const res = await handler(req);
  const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; code?: string } | null;
  if (!res.ok || !payload || payload.ok !== true) {
    const detail = payload?.error ?? `HTTP ${res.status}`;
    throw new Error(`${payload?.code ?? "REQUEST_FAILED"}: ${detail}`);
  }
  return payload;
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function num(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function bool(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}

function idList(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (!Array.isArray(value)) return undefined;
  const ids = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return ids.length ? ids : undefined;
}

/**
 * Translate a user-facing name into the id the route handler requires.
 *
 * The underlying `POST /api/v1/transactions/detail` only accepts ids, but agents
 * naturally work with names. Resolving here keeps the documented contract true
 * and keeps the ambiguity error actionable instead of a bare "account not found".
 */
async function resolveAccountIdByName(ctx: McpToolContext, name: string | undefined): Promise<string | undefined> {
  if (!name) return undefined;
  const rows = await prisma.account.findMany({
    where: { householdId: ctx.householdId, name, isActive: true, isPlaceholder: { not: true } },
    select: { id: true },
    take: 2,
  });
  if (rows.length === 0) {
    throw new Error(`No account named "${name}". Call mmh_list_accounts to check the exact name.`);
  }
  if (rows.length > 1) {
    throw new Error(`More than one account is named "${name}". Pass accountId instead.`);
  }
  return rows[0].id;
}

async function resolveCategoryIdByName(
  ctx: McpToolContext,
  name: string | undefined,
  type: string | undefined,
): Promise<string | undefined> {
  if (!name) return undefined;
  const rows = await prisma.category.findMany({
    where: {
      householdId: ctx.householdId,
      name,
      ...(type === "expense" || type === "income" ? { type } : {}),
    },
    select: { id: true },
    take: 2,
  });
  if (rows.length === 0) {
    throw new Error(`No category named "${name}". Call mmh_list_categories to check the exact name.`);
  }
  if (rows.length > 1) {
    throw new Error(`More than one category is named "${name}". Pass categoryId instead.`);
  }
  return rows[0].id;
}

export const MCP_TOOLS: McpTool[] = [
  {
    name: "mmh_list_accounts",
    title: "Accounts",
    write: false,
    description: [
      "List every account in the ledger with its balance. No kind filter is applied: cash, debit card,",
      "credit card, e-wallet, deposit, investment (fund / wealth / bond / stock / precious metal /",
      "fixed asset), settlement, loan and insurance accounts are all included.",
      "Balances are computed server-side per account type: pure investment accounts return market value,",
      "insurance returns its display balance, credit cards return the current billing cycle, everything",
      "else returns the maintained balance. Never recompute a balance from raw records.",
      "Each row carries id, name, balance, kind, investProductType, currency, institutionName, groupName.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["cash", "bank_debit", "bank_credit", "ewallet", "deposit", "investment", "settlement", "loan", "other", "insurance"],
          description: "Filter by account kind; omit for all",
        },
        investProductType: {
          type: "string",
          enum: ["fund", "money", "wealth", "bond", "deposit", "metal", "stock", "property"],
          description: "Filter by investment product type; omit for all",
        },
      },
      additionalProperties: false,
    },
    async invoke(_args, ctx) {
      const result = (await callRoute(accountsGET, ctx, "/api/v1/accounts")) as {
        accounts?: Array<Record<string, unknown>>;
      };
      return { accounts: result.accounts ?? [] };
    },
  },

  {
    name: "mmh_list_categories",
    title: "Categories",
    write: false,
    description: [
      "List the ledger's category tree. MMH has three levels: level 1 is the transaction type",
      "(expense / income / transfer / advance / investment), level 2 is a top-level category under it,",
      "level 3 is a child of that. Fixed asset is a level-2 category under expense, not under housing.",
      "Only existing categories can be used when recording, and the exact name is required, so look the",
      "name up here first.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["expense", "income", "advance", "transfer", "investment"],
          description: "Filter by transaction type; omit for all",
        },
      },
      additionalProperties: false,
    },
    async invoke(args, ctx) {
      return callRoute(categoryGET, ctx, "/api/v1/category", { query: { type: str(args, "type") } });
    },
  },

  {
    name: "mmh_list_transactions",
    title: "Transactions",
    write: false,
    description: [
      "Read ledger rows for one account, page by page. This is the fallback atomic query.",
      "Important limit: there is no date-range filter, so it cannot answer \"this month\" questions",
      "without paging through the whole account. Use mmh_get_monthly_summary or",
      "mmh_query_investment_flow for those instead of scanning rows.",
      "Rows carry id, date, postedAt, type, amount, accountName, toAccountName, categoryName, note.",
      "Amounts are signed: expense negative, income positive.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Account id" },
        page: { type: "integer", minimum: 1, default: 1 },
        pageSize: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        locateDate: { type: "string", description: "YYYY-MM-DD; jump to the page near this date (alternative to page)" },
      },
      additionalProperties: false,
    },
    async invoke(args, ctx) {
      return callRoute(txDetailGET, ctx, "/api/v1/transactions/detail", {
        query: {
          accountId: str(args, "accountId"),
          page: num(args, "page") !== undefined ? String(num(args, "page")) : undefined,
          pageSize: num(args, "pageSize") !== undefined ? String(num(args, "pageSize")) : undefined,
          locateDate: str(args, "locateDate"),
        },
      });
    },
  },

  {
    name: "mmh_get_investment_shell",
    title: "Investment account view",
    write: false,
    description: [
      "One-shot view of a single investment account: holdings, cleared holdings, all detail rows, and",
      "total market value / cost / historical profit. Covers fund, wealth, precious metal and fixed-asset",
      "accounts. Use mmh_list_bond_lots for bonds and mmh_list_deposit_lots for deposits.",
      "Each `allEntries` row carries date (application date), fundConfirmDate (T+N confirmation date),",
      "amount, fundCode, fundName, fundSubtype, fundUnits, fundNav, fundFee, fundArrivalAmount and",
      "regularInvestPlanId (non-null means it came from a regular-investment plan).",
      "Caliber notes: date is the application date and fundConfirmDate is the T+N confirmation date, so",
      "they may fall in different months; rows with fundSubtype=dividend_reinvest add units without any",
      "cash movement and must be excluded from any buy total.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Investment account id" },
        fundCode: { type: "string", description: "Limit to one fund; omitted picks the largest holding by market value" },
        entryScope: { type: "string", enum: ["fund", "account"], default: "account" },
        showCleared: { type: "boolean", default: false },
      },
      required: ["accountId"],
      additionalProperties: false,
    },
    async invoke(args, ctx) {
      const showCleared = bool(args, "showCleared");
      return callRoute(shellDataGET, ctx, "/api/v1/fund/shell-data", {
        query: {
          accountId: str(args, "accountId"),
          fundCode: str(args, "fundCode"),
          entryScope: str(args, "entryScope") ?? "account",
          showCleared: showCleared === true ? "1" : undefined,
        },
      });
    },
  },

  {
    name: "mmh_list_deposit_lots",
    title: "Deposit certificates",
    write: false,
    description: [
      "List deposit certificates: one certificate = one buy = one holding. A single deposit product can",
      "have many certificates (one per deposit; a renewal creates a new one), possibly spread across",
      "several deposit accounts of the same institution.",
      "Certificate-level fields: term, rate, maturity date, interest payout schedule, remaining principal.",
      "The product itself (DepositProduct) is only naming and terms master data and has no balance.",
      "Closed certificates are excluded by default.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        accountIds: { type: "array", items: { type: "string" }, description: "Deposit account ids; omit for all" },
        includeClosed: { type: "boolean", default: false },
      },
      additionalProperties: false,
    },
    async invoke(args, ctx) {
      const accountIds = idList(args, "accountIds");
      const includeClosed = bool(args, "includeClosed");
      return callRoute(depositLotsGET, ctx, "/api/v1/deposit/lots", {
        query: {
          accountIds: accountIds?.join(","),
          includeClosed: includeClosed === true ? "1" : undefined,
        },
      });
    },
  },

  {
    name: "mmh_list_bond_lots",
    title: "Bond certificates",
    write: false,
    description: [
      "List bond certificates. A bond (treasury or urban-investment) is a wealth product, not a fund, and",
      "follows the deposit model: one buy row = one certificate = one holding, and a single bond product",
      "can hold several certificates because each one generates its own payouts.",
      "Bonds have no units and no NAV, so never show unit / NAV / cost-basis columns for them. The clause",
      "snapshot (term, maturity date, payout frequency, first payout date, interest calculation basis) is",
      "stored on the certificate.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        accountIds: { type: "array", items: { type: "string" }, description: "Bond account ids; omit for all" },
      },
      additionalProperties: false,
    },
    async invoke(args, ctx) {
      const accountIds = idList(args, "accountIds");
      return callRoute(bondLotsGET, ctx, "/api/v1/bond/lots", {
        query: { accountIds: accountIds?.join(",") },
      });
    },
  },

  {
    name: "mmh_query_investment_flow",
    title: "Investment flow summary",
    write: false,
    description: [
      "Aggregate buy / sell amounts for investment products over a date range. The server computes the",
      "totals; use this for \"how much did I buy this month\", \"how much did I redeem this year\" and",
      "\"how much went into regular investment\".",
      "Fixed server-side caliber (do not recompute from detail rows):",
      "- dateBasis=apply groups by application date; dateBasis=confirm groups by confirmation date.",
      "  A purchase at month end confirms T+N in the next month, so the two can differ. Default is apply.",
      "- dividend_reinvest is not counted as a buy: it adds units without any cash movement.",
      "- buy_failed refunds are deducted from the buy total.",
      "- Purchases made by a regular-investment plan count as buys and are reported separately in",
      "  buy.regularInvestAmount.",
      "- A buy amount is the subscription amount including fees, not units x NAV, and not the redemption",
      "  arrival amount.",
      "- Only non-deleted rows are counted.",
      "- Covers funds and money-market funds only. Wealth, bond, precious metal and fixed asset keep their",
      "  own business tables and are not supported here yet.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Start date YYYY-MM-DD" },
        to: { type: "string", description: "End date YYYY-MM-DD (inclusive)" },
        subtype: { type: "string", enum: ["buy", "sell", "all"], default: "buy", description: "Buys, sells, or both" },
        productType: { type: "string", enum: ["fund", "money", "all"], default: "fund", description: "Investment product type" },
        dateBasis: { type: "string", enum: ["apply", "confirm"], default: "apply", description: "Group by application date or confirmation date" },
        groupBy: { type: "string", enum: ["none", "fund", "account"], default: "fund" },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
    async invoke(args, ctx) {
      const input: InvestmentFlowInput = {
        householdId: ctx.householdId,
        from: str(args, "from") ?? "",
        to: str(args, "to") ?? "",
        subtype: (str(args, "subtype") as InvestmentFlowInput["subtype"]) ?? "buy",
        productType: (str(args, "productType") as InvestmentFlowInput["productType"]) ?? "fund",
        dateBasis: (str(args, "dateBasis") as InvestmentFlowInput["dateBasis"]) ?? "apply",
        groupBy: (str(args, "groupBy") as InvestmentFlowInput["groupBy"]) ?? "fund",
      };
      return queryInvestmentFlow(input);
    },
  },

  {
    name: "mmh_get_monthly_summary",
    title: "Monthly income and expense summary",
    write: false,
    description: [
      "Return the ledger's income and expense statistics for a year: yearly totals, per-month income,",
      "expense and net, plus category / tag / institution distributions. Exactly the same caliber as the",
      "Web statistics page, computed server-side, so do not recompute from ledger rows.",
      "Expense totals keep the category sign offset: cash flows stored as positive expenses are returned",
      "as negative expense. Prefer this tool for \"how much did I spend this month\" and \"which category",
      "cost the most\".",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        year: { type: "string", description: "Four-digit year YYYY; omit for the current year" },
        accountIds: { type: "array", items: { type: "string" }, description: "Keep rows matching these source or destination accounts" },
        tagIds: { type: "array", items: { type: "string" }, description: "Keep only rows carrying these tags" },
      },
      additionalProperties: false,
    },
    async invoke(args, ctx) {
      const accountIds = idList(args, "accountIds");
      const tagIds = idList(args, "tagIds");
      return callRoute(statisticsGET, ctx, "/api/v1/statistics", {
        query: {
          year: str(args, "year"),
          accounts: accountIds?.join(","),
          tags: tagIds?.join(","),
        },
      });
    },
  },

  {
    name: "mmh_create_transaction",
    title: "Record a transaction",
    write: true,
    description: [
      "Create one ledger row (expense / income / transfer) in the current ledger. The server resolves the",
      "category, maintains account balances and investment positions, and writes the billing cycle, so",
      "never compute a balance yourself.",
      "- amount is the absolute value; the sign comes from type, and a negative input is made absolute.",
      "- accountId and accountName are alternatives, accountId wins. Names match exactly and an ambiguous",
      "  name is rejected, so call mmh_list_accounts when unsure.",
      "- categoryId and categoryName are alternatives, and the category must already exist; nothing is",
      "  created implicitly. Call mmh_list_categories when unsure.",
      "- A transfer needs a source (fromAccountId, or accountId / accountName) and a destination",
      "  (toAccountId, or toAccountName); they must differ.",
      "- Omitting date uses today; omitting postedAt uses date.",
      "- Loan, deposit, fund-cash, stock-cash, fund and wealth accounts cannot be the counterparty of an",
      "  ordinary transfer. Use the dedicated dialogs for those; this tool does not support them.",
      "Returns the new ledger row id. Read it back per account with mmh_list_transactions if you need to",
      "confirm.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["expense", "income", "transfer"] },
        date: { type: "string", description: "YYYY-MM-DD" },
        amount: { type: "number", exclusiveMinimum: 0, description: "Absolute amount" },
        accountId: { type: "string" },
        accountName: { type: "string", description: "Exact account name; alternative to accountId" },
        fromAccountId: { type: "string", description: "Transfer source account id" },
        toAccountId: { type: "string", description: "Transfer destination account id" },
        toAccountName: { type: "string", description: "Exact destination account name; alternative to toAccountId" },
        categoryId: { type: "string" },
        categoryName: { type: "string", description: "Exact category name; the category must already exist" },
        postedAt: { type: "string", description: "Posting date YYYY-MM-DD" },
        note: { type: "string" },
      },
      required: ["type", "amount"],
      additionalProperties: false,
    },
    async invoke(args, ctx) {
      const type = str(args, "type");
      const accountId = str(args, "accountId") ?? (await resolveAccountIdByName(ctx, str(args, "accountName")));
      const toAccountId = str(args, "toAccountId") ?? (await resolveAccountIdByName(ctx, str(args, "toAccountName")));
      const categoryId = str(args, "categoryId") ?? (await resolveCategoryIdByName(ctx, str(args, "categoryName"), type));
      return callRoute(txDetailPOST, ctx, "/api/v1/transactions/detail", {
        method: "POST",
        body: {
          type,
          date: str(args, "date"),
          amount: num(args, "amount"),
          // The handler reads `accountId` for expense/income and
          // `fromAccountId ?? accountId` for transfers.
          accountId,
          fromAccountId: str(args, "fromAccountId"),
          toAccountId,
          categoryId,
          postedAt: str(args, "postedAt"),
          note: str(args, "note"),
        },
      });
    },
  },

  {
    name: "mmh_delete_transaction",
    title: "Delete a transaction",
    write: true,
    description: [
      "Delete one recorded ledger row by id. The server snapshots it so it stays undoable, rolls back the",
      "account balance and investment positions, and cleans up dependent business rows. Do not try to",
      "reverse a row by recording a counter entry.",
      "Read the row back first (mmh_list_transactions) to confirm the target before deleting.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Ledger row id" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    async invoke(args, ctx) {
      return callRoute(txDetailDELETE, ctx, "/api/v1/transactions/detail", {
        method: "DELETE",
        query: { id: str(args, "id") },
      });
    },
  },
];

export function findMcpTool(name: string): McpTool | undefined {
  return MCP_TOOLS.find((tool) => tool.name === name);
}
