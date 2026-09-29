// fnOS unified-gateway server entrypoint.
//
// Serves the Next.js standalone app over a Unix socket (declared in app/ui/config
// as gatewaySocket, created under ${TRIM_APPDEST} which fnOS exposes as the app's
// target directory) so the fnOS unified gateway can proxy /app/mmh to it and
// forward the authenticated user context (X-Trim-Userid / X-Trim-Isadmin /
// X-Trim-Username).
//
// In parallel it listens on a local TCP port (MMH_LOCAL_TCP_PORT, default 7777)
// on MMH_LOCAL_TCP_HOST (default 0.0.0.0) so the app stays directly reachable
// without the gateway, preserving the legacy LAN-access behavior.
//
// This entrypoint is used only by the fnOS native package. Docker and Synology
// deployments keep launching .next/standalone/server.js directly.
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { getRequestHandlers } = require("next/dist/server/lib/start-server.js");

const appDest = process.env.TRIM_APPDEST || "";
const gatewaySocketPath = process.env.MMH_GATEWAY_SOCKET_PATH ||
  (appDest ? path.join(appDest, "app.sock") : "");

function log(message, error) {
  const details = error ? `: ${error.stack || error.message || String(error)}` : "";
  console.log(`[mmh-unix-server] ${message}${details}`);
}

async function listen(server, listenOptions, label) {
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      log(`Listening on ${label}`);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(listenOptions);
  });
}

async function main() {
  if (!gatewaySocketPath) {
    throw new Error("MMH_GATEWAY_SOCKET_PATH or TRIM_APPDEST is required");
  }

  const port = Number.parseInt(process.env.PORT || "0", 10);
  const hostname = process.env.HOSTNAME || "127.0.0.1";
  const handlers = await getRequestHandlers({
    dir: process.cwd(),
    port: Number.isInteger(port) && port > 0 ? port : 0,
    hostname,
    isDev: false,
    minimalMode: false,
    quiet: true,
    onDevServerCleanup: undefined,
    experimentalHttpsServer: false,
  });

  const server = http.createServer((req, res) => {
    Promise.resolve(handlers.requestHandler(req, res)).catch((error) => {
      log("Request handler failed", error);
      if (!res.headersSent) {
        res.statusCode = 500;
      }
      if (!res.writableEnded) {
        res.end("Internal Server Error");
      }
    });
  });
  server.headersTimeout = 65_000;
  server.requestTimeout = 0;
  server.on("upgrade", (req, socket, head) => {
    Promise.resolve(handlers.upgradeHandler(req, socket, head)).catch((error) => {
      log("Upgrade handler failed", error);
      socket.end();
    });
  });

  await listen(server, { path: gatewaySocketPath }, `socket ${gatewaySocketPath}`);

  const localTcpPort = Number.parseInt(process.env.MMH_LOCAL_TCP_PORT || "0", 10);
  const localTcpHost = process.env.MMH_LOCAL_TCP_HOST || "0.0.0.0";
  if (Number.isInteger(localTcpPort) && localTcpPort > 0) {
    try {
      await listen(server, { port: localTcpPort, host: localTcpHost }, `tcp ${localTcpHost}:${localTcpPort}`);
    } catch (error) {
      log(`Local compatibility port ${localTcpPort} is unavailable; gateway socket remains active`, error);
    }
  }

  const shutdown = () => {
    server.close(() => {
      try {
        fs.rmSync(gatewaySocketPath, { force: true });
      } catch (error) {
        log("Could not remove gateway socket", error);
      }
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error) => {
  log("Startup failed", error);
  process.exit(1);
});
