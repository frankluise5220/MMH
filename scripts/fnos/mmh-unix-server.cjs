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
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "production";
}

const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { getRequestHandlers } = require("next/dist/server/lib/start-server.js");

// Standalone root. This launcher is packaged next to server.js inside the
// package's `server/` directory, and Next resolves distDir / node_modules /
// public relative to the `dir` it is handed. .next/standalone/server.js pins
// both `dir` and the process cwd to its own directory:
//   const dir = path.join(__dirname)
//   process.chdir(__dirname)
// This launcher must do the same. Relying on process.cwd() instead would depend
// on whatever cwd the fnOS app framework happens to start the entrypoint in,
// which is not guaranteed to be the server directory.
const serverRoot = __dirname;
try {
  process.chdir(serverRoot);
} catch (error) {
  // Still usable: `dir` below is absolute, so Next does not need the cwd.
  console.log(`[mmh-unix-server] Could not chdir to ${serverRoot}: ${error.message}`);
}

const appDest = process.env.TRIM_APPDEST || "";
const gatewaySocketPath = process.env.MMH_GATEWAY_SOCKET_PATH ||
  (appDest ? path.join(appDest, "app.sock") : "");

// The fnOS build bakes Next's basePath to /app/mmh (see scripts/build-fnos-app.cjs)
// because the gateway forwards /app/mmh/** with the prefix intact. The gateway
// socket therefore receives prefixed URLs already. The local TCP compatibility
// port does NOT: Android / LAN clients hit "/", "/login", "/api/**" with no
// prefix, which would 404 against a basePath'd app. So the TCP listener injects
// the prefix before handing the request to Next -- the mirror of what the
// gateway does. Empty outside the fnOS package (Docker / Synology / Android
// launch server.js directly and never reach this file).
const basePath = (process.env.MMH_BASE_PATH || "").replace(/\/+$/, "");

// `next build` writes next.config into two places: inlined as a literal inside
// .next/standalone/server.js, and as `.config` in
// .next/standalone/.next/required-server-files.json. server.js assigns the
// former to __NEXT_PRIVATE_STANDALONE_CONFIG before starting; this entrypoint
// bypasses server.js (it calls getRequestHandlers directly so it can also serve
// the fnOS gateway Unix socket), so it has to reproduce that assignment.
//
// The variable does double duty, and the second job is the load-bearing one:
// next/dist/server/config.js wraps loadWebpackHook() in a try/catch whose catch
// rethrows UNLESS __NEXT_PRIVATE_STANDALONE_CONFIG is set --
//   // this can fail in standalone mode as the files aren't traced/included
//   if (!process.env.__NEXT_PRIVATE_STANDALONE_CONFIG) { throw err; }
// loadWebpackHook() require.resolve()s next/dist/compiled/@babel/runtime, which
// `output: "standalone"` deliberately does not trace into the server output
// (verified: absent from .next/standalone, from the Docker image, and from the
// v0.1.66/v0.1.67 fnOS payloads alike, so this is Next's intended shape and not
// a packaging gap). Without the variable the app dies at boot with
//   Cannot find module 'next/dist/compiled/@babel/runtime/package.json'
// exits 1 before listening, and the fnOS gateway answers 502 Bad Gateway on
// /app/mmh. That is exactly how v0.1.67 shipped a non-starting fnOS package:
// v0.1.62-v0.1.66 launched .next/standalone/server.js, which sets the variable
// itself; this launcher was introduced in v0.1.67 and did not.
function applyStandaloneConfig() {
  if (process.env.__NEXT_PRIVATE_STANDALONE_CONFIG) return true;
  for (const file of [
    path.join(serverRoot, ".next", "required-server-files.json"),
    path.join(process.cwd(), ".next", "required-server-files.json"),
  ]) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (!parsed || !parsed.config) continue;
    const config = { ...parsed.config };
    // required-server-files.json keeps distDir as ".next" while server.js
    // inlines "./.next". Verified: these two config objects are otherwise
    // key-for-key and value-for-value identical (43 keys, distDir the only
    // difference), so normalising it here makes the value byte-identical to
    // what `next build` inlines into server.js. Both spellings resolve to the
    // same directory; this is fidelity, not a correctness requirement.
    if (typeof config.distDir === "string" && !config.distDir.startsWith(".")) {
      config.distDir = `./${config.distDir}`;
    }
    process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(config);
    return true;
  }
  return false;
}

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

function socketIsServed(socketPath) {
  return new Promise((resolve) => {
    const probe = net.connect(socketPath);
    const finish = (alive) => {
      probe.destroy();
      resolve(alive);
    };
    probe.once("connect", () => finish(true));
    probe.once("error", () => finish(false));
    probe.setTimeout(1000, () => finish(false));
  });
}

// Node/libuv do not unlink an existing socket path before binding, so a socket
// file left behind by an ungraceful exit makes every later start fail with
//   listen EADDRINUSE: address already in use .../app.sock
// That is not hypothetical here: the fnOS lifecycle script's stop_app() waits
// only ~5s for a clean exit and then sends SIGKILL, so any restart that follows
// a hung or killed process used to wedge the app permanently (verified on the
// 5.149 test device: kill -9, then start -> EADDRINUSE, app never comes back up
// until the file is removed by hand). Clear the stale file, but never stomp a
// path that is not a socket, nor one a live process is still answering on.
async function clearStaleGatewaySocket(socketPath) {
  let stats;
  try {
    stats = fs.lstatSync(socketPath);
  } catch {
    return;
  }
  if (!stats.isSocket()) {
    log(`WARNING: ${socketPath} exists but is not a socket; leaving it untouched`);
    return;
  }
  if (await socketIsServed(socketPath)) {
    log(`WARNING: ${socketPath} is still served by another process; not removing it`);
    return;
  }
  fs.rmSync(socketPath, { force: true });
  log(`Removed stale gateway socket ${socketPath}`);
}

async function main() {
  if (!gatewaySocketPath) {
    throw new Error("MMH_GATEWAY_SOCKET_PATH or TRIM_APPDEST is required");
  }

  if (applyStandaloneConfig()) {
    log("Applied inlined standalone config (.next/required-server-files.json)");
  } else {
    // Continuing is still worth it: the failure that follows names the missing
    // module explicitly, which keeps the cause obvious in the fnOS app log.
    log("WARNING: .next/required-server-files.json not found; starting without the inlined standalone config");
  }

  const port = Number.parseInt(process.env.PORT || "0", 10);
  const hostname = process.env.HOSTNAME || "127.0.0.1";
  const handlers = await getRequestHandlers({
    dir: serverRoot,
    port: Number.isInteger(port) && port > 0 ? port : 0,
    hostname,
    isDev: false,
    minimalMode: false,
    quiet: true,
    onDevServerCleanup: undefined,
    experimentalHttpsServer: false,
  });

  // One http.Server per listener. A single http.Server cannot be bound twice --
  // Node throws ERR_SERVER_ALREADY_LISTEN ("Listen method has been called more
  // than once without closing") on the second listen() -- so serving both the
  // gateway Unix socket and the local TCP compatibility port needs two servers
  // sharing one Next request handler. v0.1.67 reused a single server and the
  // local TCP port therefore never opened at all (visible in the fnOS app log
  // as "Local compatibility port 7777 is unavailable").
  const createHttpServer = (injectBasePath) => {
    const server = http.createServer((req, res) => {
      // The local TCP compatibility port serves clients that do not know about
      // the gateway prefix, so prepend it here (see `basePath` note above). The
      // gateway Unix socket must NOT do this: fnOS already forwards the prefix.
      if (injectBasePath && basePath && req.url) {
        if (req.url === "/") {
          req.url = `${basePath}/`;
        } else if (req.url.startsWith("/") && !req.url.startsWith(`${basePath}/`)) {
          req.url = `${basePath}${req.url}`;
        }
      }
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
    return server;
  };

  await clearStaleGatewaySocket(gatewaySocketPath);

  const servers = [];
  const gatewayServer = createHttpServer(false);
  servers.push(gatewayServer);
  await listen(gatewayServer, { path: gatewaySocketPath }, `socket ${gatewaySocketPath}`);

  const localTcpPort = Number.parseInt(process.env.MMH_LOCAL_TCP_PORT || "0", 10);
  const localTcpHost = process.env.MMH_LOCAL_TCP_HOST || "0.0.0.0";
  if (Number.isInteger(localTcpPort) && localTcpPort > 0) {
    const localServer = createHttpServer(true);
    try {
      await listen(localServer, { port: localTcpPort, host: localTcpHost }, `tcp ${localTcpHost}:${localTcpPort}`);
      servers.push(localServer);
    } catch (error) {
      // The gateway socket is the path fnOS actually routes /app/mmh through,
      // so a busy compatibility port must not take the app down.
      log(`Local compatibility port ${localTcpPort} is unavailable; gateway socket remains active`, error);
    }
  }

  const shutdown = () => {
    const closing = servers.map(
      (server) => new Promise((resolve) => server.close(() => resolve())),
    );
    Promise.allSettled(closing).then(() => {
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
