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
  const historyCalls = [];
  const locationCalls = [];
  const windowOpenCalls = [];
  const docHandlers = {};
  const fakeWindow = {
    fetch(input) {
      calls.push(input);
      return Promise.resolve({ ok: true });
    },
    // Each browser-level navigation exit records what the ORIGINAL implementation
    // received, so the assertions observe the address-bar/wire URL, not our patch.
    history: {
      pushState(...args) {
        historyCalls.push(["pushState", ...args]);
      },
      replaceState(...args) {
        historyCalls.push(["replaceState", ...args]);
      },
    },
    location: {
      href: "",
      assign(url) {
        locationCalls.push(["assign", url]);
      },
      replace(url) {
        locationCalls.push(["replace", url]);
      },
    },
    open(url, target, features) {
      windowOpenCalls.push([url, target, features]);
      return null;
    },
    document: {
      addEventListener(type, handler) {
        docHandlers[type] = handler;
      },
    },
    Location: { prototype: {} },
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

  const lastHistoryUrl = (kind) => {
    const call = historyCalls.filter(([name]) => name === kind).pop();
    return call?.[3];
  };

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
    /** Address-bar URL handed to the original history.pushState for one call. */
    pushStateUrl(url) {
      historyCalls.length = 0;
      fakeWindow.history.pushState(null, "", url);
      return lastHistoryUrl("pushState");
    },
    /** Address-bar URL handed to the original history.replaceState for one call. */
    replaceStateUrl(url) {
      historyCalls.length = 0;
      fakeWindow.history.replaceState(null, "", url);
      return lastHistoryUrl("replaceState");
    },
    /** Target handed to the original location.assign for one call. */
    assignUrl(url) {
      locationCalls.length = 0;
      fakeWindow.location.assign(url);
      return locationCalls[0]?.[1];
    },
    /** Target handed to the original window.open for one call. */
    openUrl(url) {
      windowOpenCalls.length = 0;
      fakeWindow.open(url);
      return windowOpenCalls[0]?.[0];
    },
    /**
     * Simulate activating one `<a>` and report what the shim did with it.
     * `href` is what getAttribute("href") returns, i.e. the attribute as written
     * in the source -- exactly what the browser would resolve against the origin.
     */
    anchorActivation({ href, target = "", type = "click", ...rest }) {
      const handler = docHandlers[type];
      if (!handler) return { prevented: false, navigatedTo: "", openedWith: undefined, installed: false };
      const anchor = {
        target,
        getAttribute: (name) => (name === "href" ? href : null),
        setAttribute: (name, value) => {
          if (name === "href") anchor.href = value;
        },
        hasAttribute: () => false,
      };
      const event = {
        type,
        target: { closest: (selector) => (selector === "a[href]" ? anchor : null) },
        defaultPrevented: false,
        button: rest.button,
        metaKey: rest.metaKey,
        ctrlKey: rest.ctrlKey,
        shiftKey: rest.shiftKey,
        preventDefault() {
          event.defaultPrevented = true;
        },
      };
      fakeWindow.location.href = "";
      windowOpenCalls.length = 0;
      handler(event);
      return {
        installed: true,
        prevented: event.defaultPrevented,
        navigatedTo: fakeWindow.location.href,
        openedWith: windowOpenCalls[0]?.[0],
      };
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

/** withoutBasePath() from src/lib/base-path.ts: strips the prefix for Next-navigation sinks. */
function loadWithoutBasePath(failures) {
  const file = GUARD_FILES.basePath;
  const signature = "export function withoutBasePath(path: string): string {";
  const block = sliceBetween(read(file), signature, "\n}", file, "withoutBasePath", failures);
  if (!block) return null;
  const plainJs = block.replace(signature, "function withoutBasePath(path) {");
  if (!plainJs.startsWith("function withoutBasePath(path) {")) {
    failures.push("withoutBasePath: signature changed shape; update check-fnos-gateway-guards.cjs to match.");
    return null;
  }
  try {
    return new Function("MMH_BASE_PATH", `${plainJs}; return withoutBasePath;`)(BASE);
  } catch (error) {
    failures.push(`withoutBasePath: extracted block does not evaluate (${error.message})`);
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

// Hand-written URL exits never reach Next's basePath rewriting, and the runtime
// shim above is only the safety net: the call site has to be correct too, or the
// two layers drift apart and a channel that ships without the shim (7777 direct,
// Docker, Android) breaks in a way 5.149 cannot reproduce. The scan is textual on
// purpose -- it must also flag code paths that are never exercised in a test.
const BASE_PATH_EXIT_PATTERNS = [
  {
    label: "location.assign/replace() with a bare root path",
    pattern: /(?:^|[^\w])location\s*\.\s*(?:assign|replace)\s*\((?![^)]*withBasePath\s*\()\s*["'`]\/(?!\/)/,
  },
  {
    label: "location.href assignment with a bare root path",
    pattern: /location\s*\.\s*href\s*=\s*["'`]\/(?!\/)/,
  },
  {
    label: "history.pushState/replaceState() with a bare root path",
    pattern: /history\s*\.\s*(?:pushState|replaceState)\s*\((?![^)]*withBasePath\s*\()\s*[^)]*["'`]\/(?!\/)/,
  },
  {
    label: "window.open() with a bare root path",
    pattern: /window\s*\.\s*open\s*\((?![^)]*withBasePath\s*\()\s*["'`]\/(?!\/)/,
  },
  {
    // next/image does NOT add basePath to src (verified against
    // next/dist/shared/lib/get-img-props.js), and a raw <img> never goes through
    // Next at all. Optimized images have to stay `unoptimized` under the
    // gateway, because the /_next/image route itself is not prefixed.
    label: "image src with a bare root path",
    pattern: /\bsrc=\{?\s*["'`]\/(?!\/)/,
  },
];
const RAW_ANCHOR_PATTERN = /<a\b[^>]*?\bhref=\{?\s*["'`]\/(?!\/)/g;
const RAW_ANCHOR_LABEL = "raw <a href> with a bare root path (next/link prefixes itself; a raw anchor does not)";
// The OPPOSITE direction: Next's router adds basePath itself (addPathPrefix is
// not idempotent), so a URL that already carries the prefix -- anything read
// back from the address bar -- must go through withoutBasePath() first.
// v0.1.73: the credit-card bill page handed `window.location.pathname` to
// router.replace() after saving an entry, producing /app/mmh/app/mmh?... (404).
const ROUTER_NAV_PATTERN = /\brouter\s*\.\s*(?:push|replace)\s*\(/g;
const ROUTER_NAV_DOUBLE_PREFIX_LABEL = "Next router navigation with an already-prefixed browser URL (router adds basePath itself; strip it with withoutBasePath())";
// next/image gets no basePath from Next either, and `unoptimized` is what makes
// the gateway path work (the /_next/image route itself is not prefixed), so every
// image source has to be either already-prefixed or external. A variable or a
// static import is flagged on purpose: the author has to decide, not the scanner.
const IMAGE_SRC_PATTERN = /<(?:Image|img)\b[^>]*?\bsrc=(\{[^}]*\}|"[^"]*"|'[^']*')/g;
const IMAGE_SRC_LABEL = "image src that does not go through withBasePath() (next/image adds no basePath to src, and a raw <img> reaches the gateway root)";
const BARE_URL_EXIT_ALLOW = "fnos-basepath-allow";

/** A line we must not judge: blank, commented out, or explicitly allowed. */
function isUnscannableLine(line) {
  if (line.includes(BARE_URL_EXIT_ALLOW)) return true;
  const trimmed = line.trim();
  return !trimmed || trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

function collectBareUrlExitFailures(failures) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.tsx?$/.test(entry.name)) files.push(full);
    }
  };
  walk(path.join(root, "src"));

  assertBareUrlExitScanner(failures);

  for (const file of files) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    for (const hit of scanBareUrlExitSource(relative, read(file))) {
      failures.push(
        `${hit.file}:${hit.line}: ${hit.label} -- a bare root path loses the gateway prefix ("${BASE}"); pass it through withBasePath() (or an "// ${BARE_URL_EXIT_ALLOW}: <reason>" comment when it is deliberately raw).`,
      );
    }
  }
}

/**
 * Textual scan of one source file for bare-root URL exits. Separate from the walk
 * so the scanner can be tested against samples -- a scanner nobody tests silently
 * stops matching after a refactor, and then the contract only holds by luck.
 */
function scanBareUrlExitSource(relative, source) {
  const hits = [];
  const lines = source.split(/\r?\n/);
  const lineNumberAt = (index) => source.slice(0, index).split(/\r?\n/).length;
  const push = (line, label) => hits.push({ file: relative, line, label });

  lines.forEach((line, index) => {
    if (isUnscannableLine(line)) return;
    for (const { label, pattern } of BASE_PATH_EXIT_PATTERNS) {
      if (pattern.test(line)) push(index + 1, label);
    }
  });

  const scanMatches = (pattern, label) => {
    const scanner = new RegExp(pattern.source, "g");
    let match;
    while ((match = scanner.exec(source)) !== null) {
      const line = lineNumberAt(match.index);
      if (!isUnscannableLine(lines[line - 1] ?? "")) push(line, label);
      if (scanner.lastIndex === match.index) scanner.lastIndex += 1;
    }
  };

  scanMatches(RAW_ANCHOR_PATTERN, RAW_ANCHOR_LABEL);
  scanNextRouterHrefs(source, lines, lineNumberAt, push);

  const imageScanner = new RegExp(IMAGE_SRC_PATTERN.source, "g");
  let imageMatch;
  while ((imageMatch = imageScanner.exec(source)) !== null) {
    const expression = imageMatch[1];
    const safe = /withBasePath\s*\(/.test(expression) || /^["']?(?:(?:https?:)?\/\/|data:|blob:)/.test(expression);
    if (!safe) {
      const line = lineNumberAt(imageMatch.index);
      if (!isUnscannableLine(lines[line - 1] ?? "")) push(line, IMAGE_SRC_LABEL);
    }
    if (imageScanner.lastIndex === imageMatch.index) imageScanner.lastIndex += 1;
  }

  return hits;
}

/**
 * First argument of the call whose "(" is at `openIndex`, by bracket matching.
 * Null when the call is not closed inside `source`.
 */
function extractCallArgument(source, openIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") {
      depth += 1;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, i);
    }
  }
  return null;
}

/**
 * Flag `router.push/replace()` calls whose href is ALREADY prefixed: a
 * `.pathname` read (address bar under the gateway) or an explicit
 * withBasePath() wrap. Next prepends basePath to both, producing
 * /app/mmh/app/mmh/... . The fix is withoutBasePath(), which the scan accepts.
 */
function scanNextRouterHrefs(source, lines, lineNumberAt, push) {
  const scanner = new RegExp(ROUTER_NAV_PATTERN.source, "g");
  let match;
  while ((match = scanner.exec(source)) !== null) {
    const line = lineNumberAt(match.index);
    const arg = extractCallArgument(source, match.index + match[0].length - 1);
    if (
      arg !== null &&
      !isUnscannableLine(lines[line - 1] ?? "") &&
      !/withoutBasePath\s*\(/.test(arg) &&
      (/\bwithBasePath\s*\(/.test(arg) || /\bpathname\b/.test(arg))
    ) {
      push(line, ROUTER_NAV_DOUBLE_PREFIX_LABEL);
    }
    if (scanner.lastIndex === match.index) scanner.lastIndex += 1;
  }
}

/** Each sample is a URL exit that MUST be flagged, or a form that must NOT be. */
const BARE_URL_EXIT_SAMPLES = [
  { source: 'window.location.assign("/regular-invest?create=1");', label: "location.assign/replace() with a bare root path" },
  { source: 'window.location.replace(`/reports?view=income`);', label: "location.assign/replace() with a bare root path" },
  { source: 'window.location.href = "/?view=cash";', label: "location.href assignment with a bare root path" },
  { source: 'window.history.replaceState(null, "", `/?view=allcash`);', label: "history.pushState/replaceState() with a bare root path" },
  { source: 'window.history.pushState(state, "", "/reports?view=income");', label: "history.pushState/replaceState() with a bare root path" },
  { source: 'window.open("/api/v1/attachments/a1", "_blank");', label: "window.open() with a bare root path" },
  { source: '<Image src="/reward/alipay-9.90.jpg" alt="" unoptimized />', label: "image src with a bare root path" },
  { source: '<a href="/?accountId=1&view=detail">x</a>', label: RAW_ANCHOR_LABEL },
  { source: '<Image src={tier.qrUrl} alt="" unoptimized />', label: IMAGE_SRC_LABEL },
  { source: '<Image src={logo} alt="" unoptimized />', label: IMAGE_SRC_LABEL },
  { source: "router.replace(`${url.pathname}${url.search}`, { scroll: false });", label: ROUTER_NAV_DOUBLE_PREFIX_LABEL },
  { source: "router.push(`${window.location.pathname}?tab=1`);", label: ROUTER_NAV_DOUBLE_PREFIX_LABEL },
  { source: 'router.replace(withBasePath("/reports?view=income"));', label: ROUTER_NAV_DOUBLE_PREFIX_LABEL },
];
const BARE_URL_EXIT_CLEAN_SAMPLES = [
  'window.location.assign(withBasePath("/regular-invest?create=1"));',
  "window.location.replace(withBasePath(`/reports?view=income`));",
  'window.location.href = withBasePath("/?view=cash");',
  'window.history.replaceState(null, "", withBasePath(`/?${q}`));',
  'window.open(withBasePath("/api/v1/attachments/a1"), "_blank");',
  'window.location.assign("https://example.com/x");',
  'window.location.assign("//cdn.example.com/x");',
  '<Image src={withBasePath(tier.qrUrl)} alt="" unoptimized />',
  '<a href={withBasePath("/?accountId=1&view=detail")}>x</a>',
  '<Link href="/reports?view=income">x</Link>',
  'router.push("/reports?view=income");',
  'router.replace(`/reports?view=${view}`);',
  'router.replace(withoutBasePath(`${url.pathname}${url.search}`), { scroll: false });',
  'fetch("/api/v1/reports");',
  'window.location.href = item.url;',
  '// <a href="/legacy">x</a> -- fnos-basepath-allow: documentation sample',
];

function assertBareUrlExitScanner(failures) {
  for (const sample of BARE_URL_EXIT_SAMPLES) {
    const hits = scanBareUrlExitSource("sample.tsx", sample.source);
    if (!hits.some((hit) => hit.label === sample.label)) {
      failures.push(`bare-URL exit scan: the guard no longer flags ${JSON.stringify(sample.source)} as "${sample.label}"`);
    }
  }
  for (const source of BARE_URL_EXIT_CLEAN_SAMPLES) {
    const hits = scanBareUrlExitSource("sample.tsx", source);
    if (hits.length > 0) {
      failures.push(`bare-URL exit scan: the guard wrongly flags ${JSON.stringify(source)} as "${hits[0].label}"`);
    }
  }
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
  const withoutBasePath = loadWithoutBasePath(failures);
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

    // Navigation exits. These keep the prefix in the ADDRESS BAR, so they are only
    // visible on reload / bookmark / share -- the 2026-10-15 fnOS report class.
    expectEqual("emitted shim must prefix hand-written replaceState targets", emittedShim.replaceStateUrl("/?view=allcash"), `${BASE}/?view=allcash`);
    expectEqual("emitted shim must leave a prefixed replaceState target alone", emittedShim.replaceStateUrl(`${BASE}?view=allcash`), `${BASE}?view=allcash`);
    expectEqual("emitted shim must prefix hand-written pushState targets", emittedShim.pushStateUrl("/reports?view=income"), `${BASE}/reports?view=income`);
    expectEqual("emitted shim must leave a prefixed pushState target alone", emittedShim.pushStateUrl(`${BASE}/reports?view=income`), `${BASE}/reports?view=income`);
    expectEqual("emitted shim must prefix location.assign targets", emittedShim.assignUrl("/regular-invest?create=1"), `${BASE}/regular-invest?create=1`);
    expectEqual("emitted shim must leave absolute location targets alone", emittedShim.assignUrl("http://nas/x"), "http://nas/x");
    expectEqual("emitted shim must prefix window.open targets", emittedShim.openUrl("/api/v1/attachments/a1"), `${BASE}/api/v1/attachments/a1`);

    // Raw anchors. This is what the 「新增计划」 report actually did: a bare
    // /regular-invest?create=1 reached http://nas:5666/..., where fnOS routes
    // nothing to MMH and answers with its own "no page installed here" shell.
    const bareAnchor = emittedShim.anchorActivation({ href: "/regular-invest?create=1" });
    expectEqual("emitted shim must intercept a raw root anchor", bareAnchor.prevented, true);
    expectEqual("emitted shim must navigate a raw root anchor with the prefix", bareAnchor.navigatedTo, `${BASE}/regular-invest?create=1`);
    const blankAnchor = emittedShim.anchorActivation({ href: "/api/v1/attachments/a1", target: "_blank" });
    expectEqual("emitted shim must intercept a raw target=_blank anchor", blankAnchor.prevented, true);
    expectEqual("emitted shim must open a raw target=_blank anchor with the prefix", blankAnchor.openedWith, `${BASE}/api/v1/attachments/a1`);
    const middleClickAnchor = emittedShim.anchorActivation({ href: "/api/v1/attachments/a1", type: "auxclick" });
    expectEqual("emitted shim must open a raw middle-click anchor with the prefix", middleClickAnchor.openedWith, `${BASE}/api/v1/attachments/a1`);
    const prefixedAnchor = emittedShim.anchorActivation({ href: `${BASE}/overview` });
    expectEqual("emitted shim must NOT intercept a next/link anchor (it already carries the prefix)", prefixedAnchor.prevented, false);
    expectEqual("emitted shim must NOT navigate a next/link anchor itself", prefixedAnchor.navigatedTo, "");
    const externalAnchor = emittedShim.anchorActivation({ href: "https://example.com/x" });
    expectEqual("emitted shim must NOT intercept an external anchor", externalAnchor.prevented, false);
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

  if (withoutBasePath) {
    expectEqual("withoutBasePath must strip the bare prefix", withoutBasePath(`${BASE}?view=allcash`), "/?view=allcash");
    expectEqual("withoutBasePath must strip a prefixed route", withoutBasePath(`${BASE}/overview?_rsc=abc`), "/overview?_rsc=abc");
    expectEqual("withoutBasePath must leave an app-relative path alone", withoutBasePath("/?view=allcash"), "/?view=allcash");
    expectEqual("withoutBasePath must not strip a lookalike prefix", withoutBasePath("/app/mmhx?view=allcash"), "/app/mmhx?view=allcash");
    if (withBasePath) {
      // Round trip: the address bar always shows withBasePath(app path), and the
      // app path is what a Next navigation must receive back.
      expectEqual("withoutBasePath must undo withBasePath (root)", withoutBasePath(withBasePath("/?view=allcash")), "/?view=allcash");
      expectEqual("withoutBasePath must undo withBasePath (route)", withoutBasePath(withBasePath("/accounts?tab=credit")), "/accounts?tab=credit");
    }
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

  // Layer 1: the call sites themselves.
  collectBareUrlExitFailures(failures);

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
