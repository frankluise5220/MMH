#!/usr/bin/env node
/**
 * Windows 更新源上传。测试通道和公开源**只差一个下载地址**，所以只有一份脚本、
 * 一套文件清单：`--target test` 传群晖，`--target public` 传 dl.floatingice.win。
 *
 * 为什么必须合成一个脚本（2026-11-03）：
 *   两边原本是两套手工动作。0.1.81 回滚时，公开源上的 latest.yml 恢复了 0.1.80，
 *   同批的 mmh-app-latest.json 却被改名成 .bak 就没人管了 —— 结果
 *   https://dl.floatingice.win/mmh-app-latest.json 一直 404，所有已装客户端的
 *   「应用热更新」检查都在失败，而 GitHub Release 页面看起来一切正常。同一个清单
 *   在两处各维护一遍，就必然会漏一处。
 *
 * 五个文件固定一致（少一个，客户端就换一条更新通道）：
 *   mmh-win-setup-v<ver>-x64.exe / .exe.blockmap / mmh-app-v<ver>-x64.zip /
 *   latest.yml / mmh-app-latest.json
 *
 * 用法：
 *   node scripts/upload-win-feed.cjs --target test     # 群晖测试通道，上传后落戳
 *   node scripts/upload-win-feed.cjs --target public   # 公开源，必须先有测试戳
 *   node scripts/upload-win-feed.cjs --target public --dry-run
 *
 * `--target public` 的前置条件是 `release-artifacts/win/test-channel-<ver>.json`：
 * 它证明同一批字节真的到过测试通道、且之后 exe 没被重建过。这条与
 * `release-publish.cjs --publish` 的闸门同源，不通过就到此为止。
 */
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const distDir = path.join(root, "release-artifacts", "win", "dist");
const stampPath = path.join(root, "release-artifacts", "win", `test-channel-${version}.json`);

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const target = arg("target", "test");
const dryRun = process.argv.includes("--dry-run");

// 旧入口（upload-win-test-channel.cjs）用的是 --host / --dir / --base-url，一并认。
const testHost = arg("test-host", arg("host", "mmh148"));
const testDir = arg("test-dir", arg("dir", "/volume4/web/mmh-test/win"));
const testUrl = arg("test-url", arg("base-url", "http://192.168.2.148/mmh-test/win/")).replace(/\/?$/, "/");

const publicHost = arg("public-host", "fnvps");
const publicDir = arg("public-dir", "/opt/fn-appstores-server/data/downloads/win");
const publicUrl = arg("public-url", "https://dl.floatingice.win/").replace(/\/?$/, "/");

const files = [
  `mmh-win-setup-v${version}-x64.exe`,
  `mmh-win-setup-v${version}-x64.exe.blockmap`,
  `mmh-app-v${version}-x64.zip`,
  "latest.yml",
  "mmh-app-latest.json",
];

function die(message) {
  console.error(`upload-win-feed: ${message}`);
  process.exit(1);
}

function run(command, args, env) {
  execFileSync(command, args, { stdio: "inherit", cwd: root, env: env || process.env });
}

function readVersion(file) {
  const raw = fs.readFileSync(file, "utf8");
  const match = raw.match(/^\s*version:\s*(.+)$/m) || raw.match(/"version"\s*:\s*"([^"]+)"/);
  return match ? match[1].trim().replace(/^["']|["']$/g, "") : "";
}

function sha512Of(file) {
  return crypto.createHash("sha512").update(fs.readFileSync(file)).digest("base64");
}

function ghToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const cfg = process.env.MMH_MCP_CONFIG || path.join(os.homedir(), ".codebuddy", "mcp.json");
  try {
    const json = JSON.parse(fs.readFileSync(cfg, "utf8"));
    const env = ((json.mcpServers || {}).GitHub || {}).env || {};
    return env.GITHUB_PERSONAL_ACCESS_TOKEN || env.GITHUB_TOKEN || "";
  } catch {
    return "";
  }
}

function head(url) {
  return new Promise((resolve) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.request(url, { method: "HEAD" }, (res) => resolve(res.statusCode || 0));
    req.on("error", () => resolve(0));
    req.setTimeout(20000, () => {
      req.destroy();
      resolve(0);
    });
    req.end();
  });
}

/** 清单版本、本地 exe 摘要、测试戳三者必须指同一批字节。 */
function assertBuildIsTheTestedOne() {
  for (const name of ["latest.yml", "mmh-app-latest.json"]) {
    const seen = readVersion(path.join(distDir, name));
    if (seen && seen !== version) {
      die(`${name} 的版本是 ${seen}，package.json 是 ${version}；先重新构建`);
    }
  }
  if (!fs.existsSync(stampPath)) {
    die(`没有 ${path.relative(root, stampPath)}：这一版没走过测试通道。`
      + `先 --target test 上传，并在真机上用 Ctrl+Shift+U 升一次`);
  }
  const stamp = JSON.parse(fs.readFileSync(stampPath, "utf8"));
  if (String(stamp.version) !== version) {
    die(`测试戳属于 ${stamp.version}，不是 ${version}`);
  }
  const exe = files[0];
  const localSha = sha512Of(path.join(distDir, exe));
  if (stamp.sha512 && stamp.sha512 !== localSha) {
    die(`${exe} 与测试时上传的不是同一个文件（重建过）；重新上传测试通道并重测`);
  }
  return stamp;
}

async function uploadTest() {
  console.log(`target=test  version=${version}  ${testHost}:${testDir}`);
  console.log(`  url : ${testUrl}`);
  if (dryRun) {
    for (const name of files) {
      console.log(`  would upload ${name}  ${(fs.statSync(path.join(distDir, name)).size / 1048576).toFixed(1)} MiB`);
    }
    return;
  }
  run("ssh", [testHost, `mkdir -p '${testDir}'`]);
  // `-O` 走旧 SCP 协议：DSM 的 sftp 子系统被 chroot 到用户 home，绝对路径 /volume4/...
  // 会被拒（remote mkdir ... No such file or directory），ssh shell 才能看到真实文件系统。
  run("scp", ["-O", ...files.map((name) => path.join(distDir, name)), `${testHost}:${testDir}/`]);

  const exe = path.join(distDir, files[0]);
  const stamp = {
    version,
    exe: files[0],
    sha512: sha512Of(exe),
    size: fs.statSync(exe).size,
    host: testHost,
    remoteDir: testDir,
    baseUrl: testUrl,
    uploadedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(stampPath), { recursive: true });
  fs.writeFileSync(stampPath, `${JSON.stringify(stamp, null, 2)}\n`, "utf8");
  console.log(`  stamp : ${path.relative(root, stampPath)}`);

  console.log(`\n=== 测试机验证步骤 ===`);
  console.log(`  1. 装一个上一版（如 0.1.80）的桌面版，不要手动装 ${version}`);
  console.log(`  2. 应用内按 Ctrl+Shift+U，更新源填 ${testUrl}`);
  console.log(`  3. 设置 → 系统更新 → 检查更新，走真实链路升级到 ${version}`);
  console.log(`  4. 确认能启动、能打开「系统设置」，再执行 --target public`);
}

async function uploadPublic() {
  console.log(`target=public  version=${version}  ${publicHost}:${publicDir}`);
  console.log(`  url : ${publicUrl}`);
  const stamp = assertBuildIsTheTestedOne();
  console.log(`  tested ${stamp.uploadedAt} via ${stamp.baseUrl}`);
  if (dryRun) {
    for (const name of files) {
      console.log(`  would upload ${name}  ${(fs.statSync(path.join(distDir, name)).size / 1048576).toFixed(1)} MiB`);
    }
    console.log("  would backup remote latest.yml / mmh-app-latest.json, then run gh release upload");
    return;
  }

  // 先备份再覆盖：回滚时两个清单一起回，不会出现「一个回到旧版、另一个失踪」。
  const backup = `cd ${publicDir} && for f in latest.yml mmh-app-latest.json; do if [ -f "$f" ]; then cp -p "$f" "$f.bak-${version}"; fi; done; echo backup-ok`;
  run("ssh", [publicHost, backup]);
  run("scp", ["-O", ...files.map((name) => path.join(distDir, name)), `${publicHost}:${publicDir}/`]);

  // 安装包进 Release；zip 与两个清单只留在更新源（Release 不放热更新资产）。
  const token = ghToken();
  run(
    "gh",
    ["release", "upload", `v${version}`, ...files.slice(0, 3).map((name) => path.join(distDir, name)), "--clobber"],
    token ? { ...process.env, GH_TOKEN: token } : process.env
  );

  // 传完立刻验线上：五个文件都要能取到，且 latest.yml 指向本版。
  console.log("\n=== 线上校验 ===");
  const problems = [];
  for (const name of files) {
    const code = await head(publicUrl + encodeURIComponent(name));
    console.log(`  ${code === 200 ? "ok   " : "FAIL "} ${code}  ${name}`);
    if (code !== 200) problems.push(name);
  }
  const online = await (async () => {
    try {
      return await new Promise((resolve) => {
        const mod = https;
        mod.get(`${publicUrl}latest.yml`, (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve(body));
        }).on("error", () => resolve(""));
      });
    } catch {
      return "";
    }
  })();
  const onlineVersion = (online.match(/^\s*version:\s*(.+)$/m) || [])[1];
  if (String(onlineVersion || "").trim().replace(/^["']|["']$/g, "") !== version) {
    console.log(`  FAIL latest.yml 线上版本是 ${onlineVersion || "(空)"}，应为 ${version}`);
    problems.push("latest.yml 版本不符");
  }
  if (problems.length) die(`公开源没传全：${problems.join(", ")}；补传后再发布 Release`);
  console.log(`\n公开源已就绪：${publicUrl}`);
}

(async () => {
  console.log(`upload-win-feed  version=${version}`);
  const missing = files.filter((name) => !fs.existsSync(path.join(distDir, name)));
  if (missing.length) die(`release-artifacts/win/dist 缺文件: ${missing.join(", ")}（先跑 npm run build:win:desktop）`);

  if (target === "test") await uploadTest();
  else if (target === "public") await uploadPublic();
  else die(`未知 --target ${target}（只能是 test 或 public）`);
})().catch((error) => {
  console.error(`upload-win-feed crashed: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
