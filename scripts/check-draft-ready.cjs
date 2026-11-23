#!/usr/bin/env node
/**
 * draft 阶段的「出包三件套」自检。
 *
 * 0.1.89 的教训：draft Release 的五个资产齐了，但 Windows 测试源还停在上一版、
 * draft 镜像仓库里没有当版 tag —— 用户在真机上「检查更新」只看到
 * `draft/mmh:0.1.89: not found`，桌面版也拿不到测试包。这两件事一直被写成
 * 「记得跑一下」，靠记性必然漏（用户已经提过好几回）。
 *
 * 所以把它们变成一条可执行的判据：draft 交出去之前跑
 *   npm run check:draft-ready -- --version <ver>
 * 四类落点全部就绪才算这一步走完：
 *   1. GitHub draft Release 存在，且当版 exe / fpk / spk 已在资产里
 *   2. Windows 测试通道 latest.yml 指向当版（5.148 = Fstation，2.148 是同一台机器的另一网段）
 *   3. draft registry 的 draft/mmh:<ver> 与 draft/mmh-updater:<ver> 匿名可读
 *   4. 本地 release-artifacts/ 里各渠道包齐（用户要装的那几份）
 */
const fs = require("fs");
const os = require("os");
const https = require("https");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function localVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  return String(pkg.version || "").trim();
}

const version = (arg("version", "") || localVersion()).replace(/^v/, "");
const testHost = arg("test-host", "mmh148-5");
const testDir = arg("test-dir", "/volume4/web/mmh-test/win");
const testUrl = arg("test-url", "http://192.168.5.148/mmh-test/win/").replace(/\/?$/, "/");
const registry = arg("registry", "https://fnapp.floatingice.win");
const repo = arg("repo", process.env.MMH_GITHUB_REPO || "frankluise5220/MMH");
const skipRelease = process.argv.includes("--skip-release");
const skipWin = process.argv.includes("--skip-win");
const skipRegistry = process.argv.includes("--skip-registry");
const skipLocal = process.argv.includes("--skip-local");

const failures = [];
const warnings = [];

function ok(label, detail) {
  console.log(`  ok    ${label}${detail ? `  ${detail}` : ""}`);
}

function fail(label, detail) {
  console.log(`  FAIL  ${label}${detail ? `  ${detail}` : ""}`);
  failures.push(label);
}

function warn(label, detail) {
  console.log(`  warn  ${label}${detail ? `  ${detail}` : ""}`);
  warnings.push(label);
}

function ghToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  // 本仓库的既有习惯：发布脚本都从 VPS 上的只读文件取 token（本地 gh 未登录）。
  try {
    const token = execFileSync("ssh", ["fnvps", "cat /etc/mmh-admin/github-token"], {
      encoding: "utf8",
      timeout: 20000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (token) return token;
  } catch {
    // 落到 mcp.json
  }
  const cfg = process.env.MMH_MCP_CONFIG || path.join(os.homedir(), ".codebuddy", "mcp.json");
  try {
    const json = JSON.parse(fs.readFileSync(cfg, "utf8"));
    const env = ((json.mcpServers || {}).GitHub || {}).env || {};
    return env.GITHUB_PERSONAL_ACCESS_TOKEN || env.GITHUB_TOKEN || "";
  } catch {
    return "";
  }
}

function httpsJson(url, headers) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: headers || {} }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          resolve({ status: res.statusCode, body });
          return;
        }
        try {
          resolve({ status: 200, body, json: JSON.parse(body) });
        } catch {
          resolve({ status: 200, body });
        }
      });
    });
    req.on("error", (error) => resolve({ status: 0, body: String(error.message || error) }));
    req.setTimeout(20000, () => {
      req.destroy();
      resolve({ status: 0, body: "timeout" });
    });
  });
}

const MANIFEST_ACCEPT = [
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
].join(",");

/**
 * draft 的 `releases/tags/<tag>` 在本仓库的 token 权限下恒 404（0.1.89 实测：
 * `gh release list` 能看到 Draft，`gh api .../releases/tags/v0.1.89` 却 Not Found），
 * 所以列表接口是主路径，tags 端点只用来说明状态码。
 */
async function fetchRelease(token) {
  const headers = {
    "user-agent": "mmh-check-draft-ready",
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
  };
  const list = await httpsJson(`https://api.github.com/repos/${repo}/releases?per_page=100`, headers);
  if (list.status === 200 && Array.isArray(list.json)) {
    const hit = list.json.find((item) => item.tag_name === `v${version}`);
    if (hit) return { release: hit, status: 200 };
  }
  const direct = await httpsJson(`https://api.github.com/repos/${repo}/releases/tags/v${version}`, headers);
  if (direct.status === 200) return { release: direct.json, status: 200 };
  return { release: null, status: list.status || direct.status };
}

/** 1) GitHub draft：存在即说明资产有落点；缺件单独报，避免「draft 建了但没传包」。 */
async function checkRelease() {
  console.log(`\n[1/4] GitHub draft Release v${version}`);
  const token = ghToken();
  if (!token) {
    warn("GitHub draft 未检查", "没有 GH_TOKEN");
    return;
  }
  const { release, status } = await fetchRelease(token);
  if (!release) {
    fail("Release 不存在", `HTTP ${status}`);
    return;
  }
  if (!release.draft) warn("Release 已公开", "本脚本只用于 draft 阶段");
  const names = (release.assets || []).map((asset) => asset.name);
  const expectations = [
    { label: "Windows exe", test: (name) => name === `mmh-win-setup-v${version}-x64.exe` },
    { label: "fnOS FPK", test: (name) => name.startsWith(`mmh-fnos-v${version}-`) && name.endsWith(".fpk") },
    { label: "Synology SPK", test: (name) => name.startsWith(`mmh-synology-v${version}-`) && name.endsWith(".spk") },
  ];
  for (const item of expectations) {
    const hit = names.filter(item.test);
    if (hit.length) ok(item.label, hit.join(" "));
    else fail(`${item.label} 缺失`, "在 scope 内就必须先上传到 draft");
  }
}

/** 2) Windows 测试通道：latest.yml 必须已经是当版，否则真机 Ctrl+Shift+U 只能看到旧版本。 */
function checkWindowsChannel() {
  console.log(`\n[2/4] Windows 测试通道 ${testHost}:${testDir}`);
  let body = "";
  try {
    body = execFileSync("ssh", [testHost, `cat '${testDir}/latest.yml' 2>/dev/null`], { encoding: "utf8" });
  } catch (error) {
    fail("读不到 latest.yml", String(error.message || error).slice(0, 120));
    return;
  }
  const seen = ((body.match(/^\s*version:\s*(.+)$/m) || [])[1] || "").trim().replace(/^["']|["']$/g, "");
  if (!seen) {
    fail("latest.yml 没有 version");
    return;
  }
  if (seen === version) ok("latest.yml", `version=${seen}  ${testUrl}`);
  else fail("latest.yml 不是当版", `远端 ${seen}，本地 ${version}（先 npm run test:win:upload）`);
}

/** 3) draft registry：updater 在容器里就是按这个 443 地址检查镜像版本的。 */
async function checkDraftRegistry() {
  console.log(`\n[3/4] draft registry ${registry}/v2/draft/*/manifests/${version}`);
  for (const repoName of ["mmh", "mmh-updater"]) {
    const res = await httpsJson(`${registry}/v2/draft/${repoName}/manifests/${version}`, {
      accept: MANIFEST_ACCEPT,
    });
    if (res.status === 200) ok(`draft/${repoName}`, version);
    else fail(`draft/${repoName}:${version} 取不到`, `HTTP ${res.status}（ssh fnvps "sh /opt/mmh-draft-registry/sync-draft-image.sh --version ${version} --sha <7位短sha>"）`);
  }
}

/** 4) 本地包：用户要在真机上装的那几份必须已经在固定目录里。 */
function checkLocalArtifacts() {
  console.log(`\n[4/4] 本地 release-artifacts`);
  const groups = [
    {
      label: "fnOS FPK",
      dir: path.join(root, "release-artifacts", "fnos"),
      match: (name) => name.startsWith(`mmh-fnos-v${version}-`) && name.endsWith(".fpk"),
      min: 1,
    },
    {
      label: "Synology SPK",
      dir: path.join(root, "release-artifacts", "synology"),
      match: (name) => name.startsWith(`mmh-synology-v${version}-`) && name.endsWith(".spk"),
      min: 2,
    },
    {
      label: "Windows exe",
      dir: path.join(root, "release-artifacts", "win", "dist"),
      match: (name) => name === `mmh-win-setup-v${version}-x64.exe`,
      min: 1,
    },
  ];
  for (const group of groups) {
    let names = [];
    try {
      names = fs.readdirSync(group.dir).filter(group.match);
    } catch {
      names = [];
    }
    if (names.length >= group.min) ok(group.label, names.join(" "));
    else fail(`${group.label} 本地缺包`, `${path.relative(root, group.dir)} 里找不到当版文件`);
  }
}

(async () => {
  console.log(`check-draft-ready  version=${version}`);
  if (!skipRelease) await checkRelease();
  if (!skipWin) checkWindowsChannel();
  if (!skipRegistry) await checkDraftRegistry();
  if (!skipLocal) checkLocalArtifacts();

  console.log("");
  if (failures.length) {
    console.log(`draft 未就绪：${failures.length} 项失败`);
    for (const item of failures) console.log(`  - ${item}`);
    process.exit(1);
  }
  console.log(`draft 就绪${warnings.length ? `（${warnings.length} 项 warn）` : ""}：四类落点都指向 ${version}`);
})();
