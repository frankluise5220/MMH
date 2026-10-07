/**
 * Access-Key scope policy.
 *
 * Access Keys are for external business-data clients (Android, MCP agents),
 * not for administrator or maintenance APIs. Browser sessions are unaffected:
 * they are authorized per route, not by this policy.
 *
 * This is an ALLOWLIST, not a blocklist. A new `/api/v1` route is unreachable
 * with an Access Key until it is registered here. The previous blocklist
 * defaulted to "allow", so every unauthenticated route added later silently
 * became reachable by any Access Key holder (see `docs/mcp-agent-api.md`).
 *
 * The entries below mirror exactly which handlers call `getApiHouseholdScope`
 * and with which methods. When you add a route for external clients, register
 * it here in the same change; when you remove one, drop it here too.
 */

export type ApiKeyPolicyDecision = {
  ok: boolean;
  code?: string;
  error?: string;
};

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Exact paths reachable with an Access Key, mapped to the methods each allows.
 */
const ALLOWED_PATH_METHODS: Record<string, readonly HttpMethod[]> = {
  // MCP endpoint for external AI agents (JSON-RPC over HTTP POST). GET is
  // allowed through so the route can answer 405 instead of the policy
  // answering 403, which clients misread as an authentication failure.
  "/api/v1/mcp": ["POST", "GET"],

  // Accounts and master data
  "/api/v1/accounts": ["GET"],
  "/api/v1/accounts/investment": ["GET"],
  "/api/v1/category": ["GET"],
  // Loan category master data: read-only, needed to resolve Account.loanCategoryId.
  "/api/v1/loan-categories": ["GET"],

  // Bookkeeping ledger
  "/api/v1/transactions": ["GET"],
  "/api/v1/transactions/detail": ["GET", "POST", "PUT", "DELETE"],
  "/api/v1/statistics": ["GET"],

  // Investment views
  "/api/v1/fund/shell-data": ["GET"],
  "/api/v1/deposit/lots": ["GET"],
  "/api/v1/bond/lots": ["GET"],
  "/api/v1/precious-metals/dictionaries": ["GET"],
  "/api/v1/reports/stock-holdings": ["GET"],

  // Properties
  "/api/v1/properties": ["GET", "POST", "PUT"],
  "/api/v1/properties/valuations": ["POST"],

  // Stocks
  "/api/v1/stocks/securities": ["GET", "POST", "PATCH"],
  "/api/v1/stocks/transactions": ["GET", "POST", "PATCH", "DELETE"],
  "/api/v1/stocks/transactions/batch-update": ["POST"],
  "/api/v1/stocks/holdings": ["GET", "POST"],
  "/api/v1/stocks/fee-rules": ["GET", "POST"],
  "/api/v1/stocks/cash-transfer": ["POST"],
  "/api/v1/stocks/prices/manual": ["PUT"],
  "/api/v1/stocks/prices/refresh": ["POST"],
  "/api/v1/stocks/prices/refresh-daily": ["POST"],
  "/api/v1/stocks/import": ["POST"],

  // Attachments
  "/api/v1/attachments": ["GET", "POST"],

  // Cash-flow linkage
  "/api/v1/business-transactions/link-cash-flow": ["POST"],
};

/**
 * Prefix entries for routes with dynamic segments, e.g.
 * `/api/v1/attachments/:id`. Checked only when no exact path matches.
 */
const ALLOWED_PREFIX_METHODS: ReadonlyArray<{
  prefix: string;
  methods: readonly HttpMethod[];
}> = [{ prefix: "/api/v1/attachments/", methods: ["GET", "DELETE"] }];

function normalizePath(pathname: string) {
  return pathname.replace(/\/+$/, "") || "/";
}

function isMethodAllowed(methods: readonly HttpMethod[], method: string) {
  return methods.includes(method as HttpMethod);
}

function deny(error: string): ApiKeyPolicyDecision {
  return { ok: false, code: "API_KEY_SCOPE_DENIED", error };
}

export function getApiKeyPolicyDecision(pathname: string, method = "GET"): ApiKeyPolicyDecision {
  const path = normalizePath(pathname);
  const verb = method.toUpperCase();

  // CORS preflight carries no data and never reaches a route handler, so it
  // must keep succeeding on allowlisted paths or the real request cannot be
  // made at all from a browser.
  if (verb === "OPTIONS") return { ok: true };

  const exact = ALLOWED_PATH_METHODS[path];
  if (exact) {
    return isMethodAllowed(exact, verb)
      ? { ok: true }
      : deny(`API keys cannot use ${verb} on this endpoint.`);
  }

  for (const entry of ALLOWED_PREFIX_METHODS) {
    if (path.startsWith(entry.prefix)) {
      return isMethodAllowed(entry.methods, verb)
        ? { ok: true }
        : deny(`API keys cannot use ${verb} on this endpoint.`);
    }
  }

  return deny("API keys cannot access this endpoint.");
}
