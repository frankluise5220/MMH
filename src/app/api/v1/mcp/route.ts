/**
 * POST /api/v1/mcp
 *
 * MCP (Model Context Protocol) Streamable HTTP endpoint for external AI agents.
 *
 * Authentication is the ordinary MMH Access Key (`Authorization: Bearer <key>`
 * or `X-Api-Key`). The endpoint is stateless: every request is authenticated on
 * its own and no MCP session is kept server-side.
 *
 * Implemented directly on JSON-RPC 2.0 rather than through an SDK so the wire
 * format can stay tolerant of both the current discovery method
 * (`server/discover`) and the widely deployed one (`initialize`). Only POST is
 * used; no SSE stream is opened.
 */
import { NextResponse } from "next/server";
import { getApiHouseholdScope } from "@/lib/server/api-auth";
import { corsHeaders } from "@/lib/http";
import { MCP_TOOLS, findMcpTool, type McpToolContext } from "@/lib/server/mcp/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Advertised when a client does not say which version it speaks. */
const DEFAULT_PROTOCOL_VERSION = "2026-07-28";

const SERVER_INFO = { name: "mmh", version: "0.1.0" };

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

function result(id: string | number | null, payload: Record<string, unknown>) {
  return { jsonrpc: "2.0", id, result: payload };
}

function error(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function requestedProtocolVersion(params: Record<string, unknown> | undefined): string {
  const direct = params?.protocolVersion;
  if (typeof direct === "string" && direct) return direct;
  const meta = params?._meta as Record<string, unknown> | undefined;
  const nested = meta?.["io.modelcontextprotocol/protocolVersion"];
  return typeof nested === "string" && nested ? nested : DEFAULT_PROTOCOL_VERSION;
}

async function handleRequest(req: JsonRpcRequest, ctx: McpToolContext) {
  const id = req.id ?? null;
  const method = req.method ?? "";
  const params = req.params ?? {};

  // Discovery: both the current spec method and the widely deployed one.
  // `resultType` and the `_meta` serverInfo are required by the 2026-07-28 spec;
  // older clients ignore both, so returning them unconditionally is safe and
  // keeps newer clients from rejecting the response.
  if (method === "initialize" || method === "server/discover") {
    const protocolVersion = requestedProtocolVersion(params);
    return result(id, {
      resultType: "complete",
      protocolVersion,
      supportedVersions: [protocolVersion],
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO },
      ttlMs: 3_600_000,
      cacheScope: "public",
      instructions:
        "MMH household ledger. Start with mmh_list_accounts to learn the accounts, then use " +
        "mmh_query_investment_flow / mmh_get_monthly_summary for aggregate questions. Never add up " +
        "detail rows yourself to answer a total.",
    });
  }

  if (method === "tools/list") {
    // A read-scoped key never sees the write tools, so the model does not plan
    // an action it will only be rejected for. Write calls are still rejected at
    // call time as well (defence in depth).
    const visibleTools = ctx.scope === "write" ? MCP_TOOLS : MCP_TOOLS.filter((tool) => !tool.write);
    return result(id, {
      tools: visibleTools.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    });
  }

  if (method === "tools/call") {
    const name = typeof params.name === "string" ? params.name : "";
    const args = (params.arguments && typeof params.arguments === "object"
      ? (params.arguments as Record<string, unknown>)
      : {}) as Record<string, unknown>;

    const tool = findMcpTool(name);
    if (!tool) {
      return error(id, -32601, `Unknown tool: ${name}`);
    }
    if (tool.write && ctx.scope !== "write") {
      return result(id, {
        content: [
          {
            type: "text",
            text: `This Access Key has scope=read, so the write tool ${tool.name} is not available. Use a key with scope=write in MMH instead.`,
          },
        ],
        isError: true,
      });
    }

    try {
      const payload = await tool.invoke(args, ctx);
      const text = JSON.stringify(payload, null, 2);
      return result(id, {
        content: [{ type: "text", text }],
        structuredContent: payload as Record<string, unknown>,
      });
    } catch (e) {
      // Tool failures are reported *as a tool result* so the model can read the
      // reason and retry differently, instead of tearing down the connection.
      return result(id, {
        content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
        isError: true,
      });
    }
  }

  if (method === "ping") return result(id, {});

  return error(id, -32601, `Method not found: ${method}`);
}

export async function POST(req: Request) {
  let ctx;
  try {
    ctx = await getApiHouseholdScope(req);
  } catch (e) {
    return NextResponse.json(
      { ok: false, code: "UNAUTHORIZED", error: e instanceof Error ? e.message : "Unauthorized" },
      { status: 401, headers: corsHeaders() },
    );
  }

  const body = (await req.json().catch(() => null)) as JsonRpcRequest | JsonRpcRequest[] | null;
  if (!body) {
    return NextResponse.json(
      error(null, -32700, "Parse error: invalid JSON body"),
      { status: 400, headers: corsHeaders() },
    );
  }

  const authorization = req.headers.get("authorization") ?? req.headers.get("x-api-key") ?? "";
  const toolContext: McpToolContext = {
    origin: new URL(req.url).origin,
    authorization,
    householdId: ctx.householdId,
    scope: ctx.accessKey?.scope ?? "write",
  };

  // A JSON-RPC notification has no id and expects no response body.
  if (!Array.isArray(body) && body.id === undefined) {
    await handleRequest(body, toolContext).catch(() => undefined);
    return new NextResponse(null, { status: 202, headers: corsHeaders() });
  }

  if (Array.isArray(body)) {
    const responses: Array<Record<string, unknown>> = [];
    for (const item of body) {
      if (item.id === undefined) {
        await handleRequest(item, toolContext).catch(() => undefined);
        continue;
      }
      responses.push(await handleRequest(item, toolContext));
    }
    return NextResponse.json(responses, { headers: corsHeaders() });
  }

  return NextResponse.json(await handleRequest(body, toolContext), { headers: corsHeaders() });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

/**
 * Streamable HTTP lets a client open a GET SSE channel for server-initiated
 * notifications. MMH has none, but the answer still matters: a 403 from the
 * scope policy reads as "authentication failed" and makes some clients abort the
 * whole connection, while a 405 clearly means "this method is not offered here"
 * and they fall back to plain POST.
 */
export async function GET() {
  return NextResponse.json(
    {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32601, message: "GET is not supported. POST JSON-RPC to this endpoint." },
    },
    { status: 405, headers: { ...corsHeaders(), Allow: "POST, OPTIONS" } },
  );
}
