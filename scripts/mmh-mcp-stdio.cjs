#!/usr/bin/env node
/**
 * stdio <-> HTTP bridge for the MMH MCP endpoint.
 *
 * Some MCP clients (Claude Desktop and, per its docs, CodeBuddy) only launch
 * `type: "stdio"` servers: a local child process that speaks newline-delimited
 * JSON-RPC on stdin/stdout. MMH serves MCP over Streamable HTTP instead, so this
 * script lets those clients connect without changing MMH.
 *
 * It is intentionally dependency-free and stateless: every request is forwarded
 * verbatim to MMH and the JSON response is written back as one line.
 * stdout carries the protocol only; all diagnostics go to stderr.
 *
 * Client configuration example:
 *   {
 *     "mcpServers": {
 *       "mmh": {
 *         "type": "stdio",
 *         "command": "node",
 *         "args": ["E:/fs/wiseme/scripts/mmh-mcp-stdio.cjs"],
 *         "env": {
 *           "MMH_MCP_URL": "http://192.168.5.199:7777/api/v1/mcp",
 *           "MMH_MCP_KEY": "<Access Key>"
 *         }
 *       }
 *     }
 *   }
 */
const readline = require("node:readline");

const ENDPOINT = (process.env.MMH_MCP_URL || "").trim();
const KEY = (process.env.MMH_MCP_KEY || "").trim();

if (!ENDPOINT || !KEY) {
  console.error("[mmh-mcp-stdio] MMH_MCP_URL and MMH_MCP_KEY are both required.");
  process.exit(1);
}

function write(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

async function forward(payload) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }

  if (!res.ok) {
    // Surface the HTTP failure as a JSON-RPC error so the client shows a real
    // reason instead of "server closed the connection".
    return {
      jsonrpc: "2.0",
      id: payload && payload.id !== undefined ? payload.id : null,
      error: {
        code: -32000,
        message: `MMH returned HTTP ${res.status}`,
        data: parsed && parsed.error ? parsed.error : text.slice(0, 300),
      },
    };
  }

  return parsed;
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let payload;
  try {
    payload = JSON.parse(trimmed);
  } catch (error) {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: " + error.message } });
    return;
  }

  // A JSON-RPC notification expects no response.
  const isNotification = !Array.isArray(payload) && payload.id === undefined;
  if (isNotification) {
    forward(payload).catch(() => undefined);
    return;
  }

  try {
    write(await forward(payload));
  } catch (error) {
    write({
      jsonrpc: "2.0",
      id: payload && payload.id !== undefined ? payload.id : null,
      error: { code: -32000, message: String(error && error.message ? error.message : error) },
    });
  }
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
