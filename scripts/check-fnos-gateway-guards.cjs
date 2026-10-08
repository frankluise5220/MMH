#!/usr/bin/env node

// fnOS gateway adapter guards (the runtime half of the cross-channel contract).
//
// Two families of bugs live here, both measured on 5.149 in v0.1.71:
//
// 1. PREFIXING. Three runtime prefixers have to answer "does this URL already
//    carry the gateway prefix?" on the URL PATH only (query/hash ignored), and
//    the BARE prefix counts as already prefixed. Next collapses a basePath'd
//    root route to the bare prefix plus its query (`/?view=allcash` ->
//    `/app/mmh?view=allcash`; likewise `/?accountId=..&view=detail`), so a raw
//    `startsWith(BASE + "/")` test misses that form, prepends the prefix a
//    second time, and every root-route request becomes `/app/mmh/app/mmh?...`
//    -> 404. v0.1.71 shipped that: 333 doubled-prefix 404s in the 5.149 gateway
//    log broke the sidebar's 「全部收支记录」, the account entries, the router's
//    own RSC fetches, and the Server Action POST that saves a transaction.
//    Rewriting the bare prefix to `BASE + "/"` is not a fix either: Next
//    308-redirects that back to the bare prefix and the shim injects again --
//    the loop that reverted the 2026-09-30 guard.
//
// 2. FORWARDED HOST. fnOS's gateway forwards `X-Forwarded-Host` with the PORT
//    STRIPPED (nginx `proxy_set_header Host $host`), while the browser's
//    `Origin` keeps it. Next's Server Action guard compares the two by exact
//    string equality, so EVERY Server Action on the gateway path answered 500
//    with a digest-only flight error and the UI showed "An error occurred in the
//    Server Components render ... A digest property is included on this error
//    instance" while reads kept working -- a silent save failure. The launcher
//    restores the port, but only when the hostNAME already agrees with the
//    ingress-reported one.
//
// The guards are EXTRACTED from their real sources instead of re-typed here, so
// this check fails the moment one of them drifts back.
//
// Run standalone (`npm run check:fnos-gateway`) or through verify-fnos-package.cjs.

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const BASE = "/app/mmh";
const GUARD_FILES = {
  layoutShim: path.join(root, "src", "app", "layout.tsx"),
  basePath: path.join(root, "src", "lib", "base-path.ts"),
  launcher: path.join(root, "scripts", "fnos", "mmh-unix-server.cjs"),
};

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function sliceBetween(source, startMarker, endMarker, file, label, failures) {
  const start = source.indexOf(startMarker);
  if (start === -1) {
    failures.push(`${label}: cannot find ${JSON.stringify(startMarker)} in ${path.relative(root, file)}`);
    return null;
  }
  const end = source.indexOf(endMarker, start);
  if (end === -1) {
    failures.push(`${label}: cannot find the end of the extracted block in ${path.relative(root, file)}`);
    return null;
  }
  return source.slice(start, end + endMarker.length);
}

/** The `rewrite()` helper inside the shim emitted into every page by src/app/layout.tsx. */
function loadLayoutShim(failures) {
  const file = GUARD_FILES.layoutShim;
  const block = sliceBetween(
    read(file),
    "  const rewrite = (input) => {",
    "\n  };",
    file,
    "client gateway shim",
    failures,
  );
  if (!block) return null;
  try {
    return new Function("BASE", `${block}; return rewrite;`)(BASE);
  } catch (error) {
    failures.push(`client gateway shim: extracted block does not evaluate (${error.message})`);
    return null;
  }
}

/**
 * The WHOLE template literal that src/app/layout.tsx ships as the inline
 * beforeInteractive script, executed against stubbed browser globals. This is
 * the artifact the browser actually runs, so it catches both a syntax error in
 * the emitted script and a `rewrite()` that is correct in isolation but wired
 * up wrongly.
 */
function loadEmittedShim(failures) {
  const file = GUARD_FILES.layoutShim;
  const source = read(file);
  const openMarker = "  ? `\n";
  const start = source.indexOf(openMarker);
  const end = start === -1 ? -1 : source.indexOf("\n`\n  : \"\";", start);
  if (start === -1 || end === -1) {
    failures.push("client gateway shim: cannot locate the emitted script template in src/app/layout.tsx");
    return null;
  }
  const body = source
    .slice(start + openMarker.length, end)
    .split("${JSON.stringify(MMH_BASE_PATH)}")
    .join(JSON.stringify(BASE));
  if (body.includes("${")) {
    failures.push("client gateway shim: the emitted script has an interpolation this checker cannot expand; teach it before shipping.");
    return null;
  }

  let factory;
  try {
    factory = new Function("window", "XMLHttpRequest", "URL", "Request", body);
  } catch (error) {
    failures.push(`client gateway shim: the emitted script is not valid JavaScript (${error.message})`);
    return null;
  }

  const calls = [];
  const fakeWindow = {
    fetch(input) {
      calls.push(input);
      return Promise.resolve({ ok: true });
    },
  };
  // The shim captures this as `originalOpen` and calls it with the rewritten
  // URL after patching, so recording here observes the wire URL.
  let lastXhrArgs = null;
  const fakeXhrPrototype = {
    open(...args) {
      lastXhrArgs = args;
    },
  };
  try {
    factory(fakeWindow, { prototype: fakeXhrPrototype }, URL, undefined);
  } catch (error) {
    failures.push(`client gateway shim: the emitted script throws while installing itself (${error.message})`);
    return null;
  }
  if (fakeWindow.fetch === undefined) {
    failures.push("client gateway shim: the emitted script did not install a fetch wrapper");
    return null;
  }

  return {
    /** Wire URL handed to the real fetch for one call. */
    fetchWireUrl(input) {
      calls.length = 0;
      fakeWindow.fetch(input);
      const [wire] = calls;
      return typeof wire === "string" ? wire : wire?.url ?? String(wire);
    },
    /** Wire URL handed to the original XMLHttpRequest.open for one call. */
    xhrWireUrl(url) {
      lastXhrArgs = null;
      fakeXhrPrototype.open("GET", url);
      return lastXhrArgs?.[1];
    },
  };
}

/** withBasePath() from src/lib/base-path.ts, the single TS prefix sink. */
function loadWithBasePath(failures) {
  const file = GUARD_FILES.basePath;
  const signature = "export function withBasePath(path: string): string {";
  const block = sliceBetween(read(file), signature, "\n}", file, "withBasePath", failures);
  if (!block) return null;
  const plainJs = block.replace(signature, "function withBasePath(path) {");
  if (!plainJs.startsWith("function withBasePath(path) {")) {
    failures.push("withBasePath: signature changed shape; update check-fnos-gateway-guards.cjs to match.");
    return null;
  }
  try {
    return new Function("MMH_BASE_PATH", `${plainJs}; return withBasePath;`)(BASE);
  } catch (error) {
    failures.push(`withBasePath: extracted block does not evaluate (${error.message})`);
    return null;
  }
}

/** The local TCP compatibility port's injection inside the fnOS launcher. */
function loadTcpInjector(failures) {
  const file = GUARD_FILES.launcher;
  const block = sliceBetween(
    read(file),
    "      if (injectBasePath && basePath && req.url) {",
    "\n      }",
    file,
    "fnOS TCP injector",
    failures,
  );
  if (!block) return null;
  let inject;
  try {
    inject = new Function("req", "injectBasePath", "basePath", block);
  } catch (error) {
    failures.push(`fnOS TCP injector: extracted block does not evaluate (${error.message})`);
    return null;
  }
  return (url) => {
    const req = { url };
    inject(req, true, BASE);
    return req.url;
  };
}

/**
 * The fnOS ingress host fix in scripts/fnos/mmh-unix-server.cjs, together with
 * the two helpers it depends on (extracted so the check exercises the shipped
 * code, not a copy).
 */
function loadForwardedHostNormalizer(failures) {
  const file = GUARD_FILES.launcher;
  const source = read(file);
  const helpers = ["function firstHeaderValue(value) {", "function hostHasPort(host) {", "function portFromOrigin(origin) {", "function hostnameAgrees(host, origin) {"]
    .map((marker) => sliceBetween(source, marker, "\n}", file, "fnOS forwarded-host helper", failures))
    .filter(Boolean)
    .join("\n");
  const main = sliceBetween(
    source,
    "function normalizeGatewayForwardedHost(headers) {",
    "\n}",
    file,
    "fnOS forwarded-host normalizer",
    failures,
  );
  if (!main) return null;
  try {
    return new Function(`${helpers}\n${main}; return normalizeGatewayForwardedHost;`)();
  } catch (error) {
    failures.push(`fnOS forwarded-host normalizer: extracted block does not evaluate (${error.message})`);
    return null;
  }
}

function countPrefixes(value) {
  return value.split(BASE).length - 1;
}

/**
 * Collect every guard regression as a message. Empty array === contract holds.
 * @returns {string[]}
 */
function collectFnosGatewayGuardFailures() {
  const failures = [];
  const rewrite = loadLayoutShim(failures);
  const emittedShim = loadEmittedShim(failures);
  const withBasePath = loadWithBasePath(failures);
  const inject = loadTcpInjector(failures);
  const normalizeForwardedHost = loadForwardedHostNormalizer(failures);

  const expectEqual = (label, actual, expected) => {
    if (actual !== expected) {
      failures.push(`${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
    }
  };
  const expectOnePrefix = (label, actual) => {
    const count = countPrefixes(actual);
    if (count !== 1) {
      failures.push(`${label}: ${JSON.stringify(actual)} carries ${count} prefixes, want exactly 1`);
    }
  };

  if (rewrite) {
    // The v0.1.71 regression: the root route under a basePath arrives already
    // prefixed, with the query glued to the bare prefix.
    expectEqual("client gateway shim must leave `/app/mmh?view=allcash` alone", rewrite(`${BASE}?view=allcash`), `${BASE}?view=allcash`);
    expectEqual("client gateway shim must leave the search-less RSC twin alone", rewrite(`${BASE}?_rsc=abc`), `${BASE}?_rsc=abc`);
    expectEqual("client gateway shim must leave `/app/mmh?accountId=x&view=detail` alone", rewrite(`${BASE}?accountId=x&view=detail`), `${BASE}?accountId=x&view=detail`);
    expectEqual("client gateway shim must leave the bare prefix alone", rewrite(BASE), BASE);
    expectEqual("client gateway shim must leave prefixed routes alone", rewrite(`${BASE}/overview?_rsc=abc`), `${BASE}/overview?_rsc=abc`);
    expectEqual("client gateway shim must prefix /api paths once", rewrite("/api/v1/accounts/internal"), `${BASE}/api/v1/accounts/internal`);
    expectEqual("client gateway shim must prefix asset paths once", rewrite("/_next/static/chunks/a.js"), `${BASE}/_next/static/chunks/a.js`);
    expectEqual("client gateway shim must prefix the root path", rewrite("/"), `${BASE}/`);
    expectEqual("client gateway shim must ignore protocol-relative URLs", rewrite("//cdn.example.com/a.js"), "//cdn.example.com/a.js");
    expectEqual("client gateway shim must ignore absolute URLs", rewrite("http://nas/a.js"), "http://nas/a.js");
  }

  if (emittedShim) {
    // Same matrix, but observed on the script the browser executes: what the
    // patched window.fetch / XMLHttpRequest.open actually send over the wire.
    expectEqual("emitted shim must send `/app/mmh?view=allcash` unchanged", emittedShim.fetchWireUrl(`${BASE}?view=allcash&_rsc=abc`), `${BASE}?view=allcash&_rsc=abc`);
    expectEqual("emitted shim must send `/app/mmh?accountId=x&view=detail` unchanged", emittedShim.fetchWireUrl(`${BASE}?accountId=x&view=detail`), `${BASE}?accountId=x&view=detail`);
    expectEqual("emitted shim must send prefixed routes unchanged", emittedShim.fetchWireUrl(`${BASE}/overview?_rsc=abc`), `${BASE}/overview?_rsc=abc`);
    expectEqual("emitted shim must prefix /api once", emittedShim.fetchWireUrl("/api/v1/accounts/internal"), `${BASE}/api/v1/accounts/internal`);
    expectEqual("emitted shim must leave absolute URLs alone", emittedShim.fetchWireUrl("http://nas/x"), "http://nas/x");
    expectEqual("emitted shim must send prefixed XHR targets unchanged", emittedShim.xhrWireUrl(`${BASE}?view=allcash`), `${BASE}?view=allcash`);
    expectEqual("emitted shim must prefix XHR targets once", emittedShim.xhrWireUrl("/api/v1/x"), `${BASE}/api/v1/x`);
  }

  if (withBasePath) {
    expectEqual("withBasePath must leave `/app/mmh?view=allcash` alone", withBasePath(`${BASE}?view=allcash`), `${BASE}?view=allcash`);
    expectOnePrefix("withBasePath must prefix `/?view=allcash` exactly once", withBasePath("/?view=allcash"));
    expectOnePrefix("withBasePath must stay idempotent for `/?view=allcash`", withBasePath(withBasePath("/?view=allcash")));
    expectOnePrefix("withBasePath must stay idempotent for `/overview`", withBasePath(withBasePath("/overview")));
    expectOnePrefix("withBasePath must stay idempotent for `/accounts?tab=credit`", withBasePath(withBasePath("/accounts?tab=credit")));
    // The service-worker scope depends on the root keeping its trailing slash.
    expectEqual("withBasePath must keep the root slash (service-worker scope)", withBasePath("/"), `${BASE}/`);
  }

  if (inject) {
    expectEqual("fnOS TCP injector must prefix the root", inject("/"), `${BASE}/`);
    expectEqual("fnOS TCP injector must keep the query when prefixing the root", inject("/?view=allcash"), `${BASE}/?view=allcash`);
    expectEqual("fnOS TCP injector must not re-inject the bare prefix", inject(`${BASE}`), BASE);
    expectEqual("fnOS TCP injector must not re-inject the prefixed root route", inject(`${BASE}?view=allcash`), `${BASE}?view=allcash`);
    expectEqual("fnOS TCP injector must not re-inject prefixed routes", inject(`${BASE}/overview`), `${BASE}/overview`);
    expectEqual("fnOS TCP injector must inject unprefixed routes", inject("/overview"), `${BASE}/overview`);
    expectEqual("fnOS TCP injector must inject unprefixed API paths", inject("/api/v1/x"), `${BASE}/api/v1/x`);
  }

  if (normalizeForwardedHost) {
    // The v0.1.71 save failure: the ingress reports the host without its port.
    const fnosShape = { "x-forwarded-host": "192.168.5.149", origin: "http://192.168.5.149:5666" };
    normalizeForwardedHost(fnosShape);
    expectEqual(
      "forwarded-host normalizer must restore the port the fnOS ingress dropped",
      fnosShape["x-forwarded-host"],
      "192.168.5.149:5666",
    );

    const alreadyPortable = { "x-forwarded-host": "192.168.5.149:5666", origin: "http://192.168.5.149:5666" };
    normalizeForwardedHost(alreadyPortable);
    expectEqual("forwarded-host normalizer must leave a host that already has a port", alreadyPortable["x-forwarded-host"], "192.168.5.149:5666");

    const explicitPort = { "x-forwarded-host": "nas.lan", "x-forwarded-port": "5666", origin: "http://nas.lan:9999" };
    normalizeForwardedHost(explicitPort);
    expectEqual("forwarded-host normalizer must prefer an explicit x-forwarded-port", explicitPort["x-forwarded-host"], "nas.lan:5666");

    const foreignOrigin = { "x-forwarded-host": "192.168.5.149", origin: "http://evil.example:5666" };
    normalizeForwardedHost(foreignOrigin);
    expectEqual(
      "forwarded-host normalizer must NOT adopt a foreign origin's port (that would defeat Next's CSRF check)",
      foreignOrigin["x-forwarded-host"],
      "192.168.5.149",
    );

    const nullOrigin = { "x-forwarded-host": "192.168.5.149", origin: "null" };
    normalizeForwardedHost(nullOrigin);
    expectEqual("forwarded-host normalizer must ignore a null origin", nullOrigin["x-forwarded-host"], "192.168.5.149");

    const noForwardedHost = { host: "192.168.5.149:7777", origin: "http://192.168.5.149:7777" };
    normalizeForwardedHost(noForwardedHost);
    expectEqual("forwarded-host normalizer must not touch direct (non-forwarded) requests", noForwardedHost["x-forwarded-host"], undefined);

    const chained = { "x-forwarded-host": "192.168.5.149, proxy.internal", origin: "http://192.168.5.149:5666" };
    normalizeForwardedHost(chained);
    expectEqual(
      "forwarded-host normalizer must use the first forwarded hop",
      chained["x-forwarded-host"],
      "192.168.5.149:5666, proxy.internal",
    );

    const ipv6 = { "x-forwarded-host": "[fd00::1]", origin: "http://[fd00::1]:5666" };
    normalizeForwardedHost(ipv6);
    expectEqual("forwarded-host normalizer must keep IPv6 literals bracketed", ipv6["x-forwarded-host"], "[fd00::1]:5666");

    // 2026-10-08 实测：fnOS 网关并不发 x-forwarded-host，而是把端口剥在
    // Host 头上（host=192.168.5.149，origin=http://192.168.5.149:5666）。
    // Next 的 Server Action 校验在 x-forwarded-host 缺失时会 fallback 到 host，
    // 所以必须同时补 Host 头的端口。
    const hostOnlyShape = { host: "192.168.5.149", origin: "http://192.168.5.149:5666" };
    normalizeForwardedHost(hostOnlyShape);
    expectEqual("forwarded-host normalizer must restore the port on the Host header when x-forwarded-host is absent", hostOnlyShape.host, "192.168.5.149:5666");
    expectEqual("forwarded-host normalizer must not invent an x-forwarded-host header", hostOnlyShape["x-forwarded-host"], undefined);

    const hostOnlyForeign = { host: "evil.example", origin: "http://192.168.5.149:5666" };
    normalizeForwardedHost(hostOnlyForeign);
    expectEqual("forwarded-host normalizer must NOT adopt a foreign origin's port onto the Host header", hostOnlyForeign.host, "evil.example");

    const hostOnlyWithPort = { host: "192.168.5.149:7777", origin: "http://192.168.5.149:5666" };
    normalizeForwardedHost(hostOnlyWithPort);
    expectEqual("forwarded-host normalizer must leave a Host header that already has a port alone", hostOnlyWithPort.host, "192.168.5.149:7777");
  }

  // The normalizer only helps if the request path actually calls it -- and a
  // commented-out call is not a call.
  const calledForReal = read(GUARD_FILES.launcher)
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .some((line) => line.includes("normalizeGatewayForwardedHost(req.headers)"));
  if (!calledForReal) {
    failures.push("scripts/fnos/mmh-unix-server.cjs must call normalizeGatewayForwardedHost(req.headers) in its request handler.");
  }

  return failures;
}

module.exports = { collectFnosGatewayGuardFailures };

if (require.main === module) {
  const failures = collectFnosGatewayGuardFailures();
  if (failures.length > 0) {
    console.error("fnOS gateway guard check failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log("fnOS gateway guard check passed.");
}
