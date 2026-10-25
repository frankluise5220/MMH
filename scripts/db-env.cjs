#!/usr/bin/env node
/**
 * 开发库 / 生产库切换工具
 *
 *   npm run db:which          查看当前各配置指向哪个库
 *   npm run dev               开发库（.env.local，可读写，predev 会自动迁移）
 *   npm run dev:prod          生产库（只读，跳过迁移，见下方说明）
 *   npm run db:migrate:dev    显式对开发库执行 prisma migrate deploy
 *
 * 生产环境一律使用只读账号 mmh_ro（default_transaction_read_only=on），
 * 任何 INSERT/UPDATE/DELETE/DDL 都会被 PostgreSQL 拒绝。
 * 生产切换走「启动时注入环境变量」，不修改 .env.local，
 * 因此 npm run dev 与 npm run dev:prod 可以交替使用、互不污染。
 */
const fs = require("fs");
const path = require("path");
const { spawn, execSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const envsDir = path.join(root, ".envs");
const PROD_HOST = "192.168.2.148";
const DEV_HOST = "192.168.5.149";

function parseEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function describe(url) {
  if (!url) return { label: "(未设置)", host: null, kind: "none" };
  let host = null;
  try {
    const u = new URL(url);
    host = u.hostname;
  } catch {
    const m = /@([^:/]+)/.exec(url);
    host = m ? m[1] : null;
  }
  if (host === PROD_HOST) return { label: "生产 PROD", host, kind: "prod" };
  if (host === DEV_HOST) return { label: "开发 DEV", host, kind: "dev" };
  if (host === "localhost" || host === "127.0.0.1") return { label: "本机 LOCAL", host, kind: "local" };
  return { label: "未知", host, kind: "other" };
}

function mask(url) {
  return url ? url.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@") : "(未设置)";
}

function resolveCurrent() {
  const fromEnvFile = parseEnvFile(path.join(root, ".env"));
  const fromLocal = parseEnvFile(path.join(root, ".env.local"));
  const url = process.env.DATABASE_URL || fromLocal.DATABASE_URL || fromEnvFile.DATABASE_URL || "";
  let source = "process.env";
  if (!process.env.DATABASE_URL) source = fromLocal.DATABASE_URL ? ".env.local" : ".env";
  return { url, source };
}

const DEV_PORT = 7777;
// 每个环境固定端口 + 独立构建目录，允许「开发库 7777」「生产库 7778」同时开着。
const ENV_PORTS = { dev: 7777, prod: 7778 };
const ENV_DIST_DIRS = { dev: "", prod: ".next-prod" };

function portOwners(port) {
  try {
    const out = execSync("netstat -ano -p tcp", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
      if (m && Number(m[1]) === port) pids.add(Number(m[2]));
    }
    return [...pids];
  } catch {
    return [];
  }
}

/** 同一端口只允许一个实例：两个 next dev 抢同一端口会互相污染编译缓存与产物。 */
function assertSingleDevServer(port) {
  const pids = portOwners(port);
  if (pids.length === 0) return;
  console.error("");
  console.error(`  端口 ${port} 已被占用（pid ${pids.join(", ")}），已中止启动。`);
  console.error("  同一个端口只能跑一个实例；开发库与生产库请用各自的端口并行。");
  console.error(`  关闭旧实例：  npm run dev:stop`);
  console.error("");
  process.exit(1);
}

function pad(s, n) {
  const w = [...String(s)].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0);
  return String(s) + " ".repeat(Math.max(0, n - w));
}

function cmdWhich() {
  console.log("");
  console.log("当前生效（npm run dev 会用的库）");
  const cur = resolveCurrent();
  const info = describe(cur.url);
  console.log(`  来源    : ${cur.source}`);
  console.log(`  目标库  : ${info.label}`);
  console.log(`  地址    : ${mask(cur.url)}`);
  console.log("");
  console.log("配置文件对照");
  const rows = [
    [".env", parseEnvFile(path.join(root, ".env")).DATABASE_URL],
    [".env.local", parseEnvFile(path.join(root, ".env.local")).DATABASE_URL],
    [".envs/dev.env", parseEnvFile(path.join(envsDir, "dev.env")).DATABASE_URL],
    [".envs/prod.env", parseEnvFile(path.join(envsDir, "prod.env")).DATABASE_URL],
  ];
  for (const [file, url] of rows) {
    const d = describe(url);
    console.log(`  ${pad(file, 16)} ${pad(d.label, 9)} ${mask(url)}`);
  }
  console.log("");
  console.log("用法（两个实例可同时开着，端口与构建目录互不干扰）");
  console.log("  npm run dev        开发库 192.168.5.149 → http://localhost:7777（可写，自动迁移，.next）");
  console.log("  npm run dev:prod   生产库 192.168.2.148 → http://localhost:7778（只读，不迁移，.next-prod）");
  console.log("  npm run dev:stop   关闭这两个实例");
  console.log("");
}

function loadNamedEnv(name) {
  if (!name) {
    console.error("缺少环境名，例如：node scripts/db-env.cjs start prod");
    process.exit(1);
  }
  const file = path.join(envsDir, `${name}.env`);
  if (!fs.existsSync(file)) {
    console.error(`找不到 ${file}`);
    process.exit(1);
  }
  return { file, values: parseEnvFile(file) };
}

function cmdStart(name) {
  const port = ENV_PORTS[name] ?? DEV_PORT;
  const distDir = ENV_DIST_DIRS[name] || "";
  assertSingleDevServer(port);
  const { file, values } = loadNamedEnv(name);
  if (!values.DATABASE_URL) {
    console.error(`${file} 里没有 DATABASE_URL`);
    process.exit(1);
  }
  const info = describe(values.DATABASE_URL);
  console.log("");
  if (info.kind === "prod") {
    console.log("  ########################################################");
    console.log("  #  生产库 · 只读模式（mmh_ro）                          #");
    console.log("  #  写操作会被数据库拒绝；不执行 prisma migrate deploy   #");
    console.log("  ########################################################");
  } else {
    console.log(`  目标库：${info.label}（${info.host}）`);
  }
  console.log(`  配置文件：${path.relative(root, file)}`);
  console.log(`  端口    ：${port}`);
  if (distDir) console.log(`  构建目录：${distDir}（与 .next 隔离，可与开发实例并行）`);
  console.log("");

  const args = ["dev", "-H", "0.0.0.0", "-p", String(port), "--webpack"];
  // 直接调用 next 的 bin，而不是依赖 PATH 里的 `next`（npm 脚本才有 bin 路径）。
  const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, [nextBin, ...args], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      ...values,
      ...(distDir ? { NEXT_DIST_DIR: distDir } : {}),
      NODE_OPTIONS: "--max-old-space-size=6144",
    },
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

function cmdMigrate(name, force) {
  const { values } = loadNamedEnv(name);
  const info = describe(values.DATABASE_URL);
  if (info.kind === "prod" && !force) {
    console.error("");
    console.error("  已拒绝：目标库是生产库，禁止执行 migrate deploy。");
    console.error("  确认要迁移生产库时，加 --force 显式放行。");
    console.error("");
    process.exit(1);
  }
  console.log(`执行 prisma migrate deploy → ${info.label}（${info.host}）`);
  const child = spawn("npx", ["prisma", "migrate", "deploy"], {
    cwd: root,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, ...values },
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

function killPort(port) {
  const pids = portOwners(port);
  if (pids.length === 0) {
    console.log(`  端口 ${port}：空闲`);
    return true;
  }
  for (const pid of pids) {
    console.log(`  端口 ${port}：关闭 pid ${pid} …`);
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
    } catch {
      /* 进程可能已自行退出 */
    }
  }
  const started = Date.now();
  while (Date.now() - started < 5000) {
    try {
      execSync("ping -n 1 -w 200 127.0.0.1 >nul", { stdio: "ignore" });
    } catch {
      /* ignore */
    }
    if (portOwners(port).length === 0) {
      console.log(`  端口 ${port}：已释放`);
      return true;
    }
  }
  console.error(`  端口 ${port}：仍被占用，请手动检查 netstat -ano | findstr :${port}`);
  return false;
}

function cmdStop(target) {
  const targets = target
    ? [[target, ENV_PORTS[target] ?? DEV_PORT]]
    : Object.entries(ENV_PORTS);
  if (target && ENV_PORTS[target] === undefined) {
    console.error(`未知环境：${target}（可用：${Object.keys(ENV_PORTS).join(" / ")}）`);
    process.exit(1);
  }
  let ok = true;
  for (const [, port] of targets) {
    ok = killPort(port) && ok;
  }
  if (!ok) process.exit(1);
}

function cmdPredev() {
  assertSingleDevServer(DEV_PORT);
  const cur = resolveCurrent();
  const info = describe(cur.url);
  if (info.kind === "prod") {
    console.log("");
    console.log("  注意：当前 DATABASE_URL 指向生产库，已跳过 prisma migrate deploy。");
    console.log("  生产只读调试请用 npm run dev:prod（不改 .env.local，也不会迁移）。");
    console.log("");
  } else {
    const deploy = spawn("npx", ["prisma", "migrate", "deploy"], {
      cwd: root,
      stdio: "inherit",
      shell: true,
    });
    deploy.on("exit", (code) => {
      if (code !== 0) process.exit(code ?? 1);
      const gen = spawn("npx", ["prisma", "generate"], { cwd: root, stdio: "inherit", shell: true });
      gen.on("exit", (c) => process.exit(c ?? 0));
    });
    return;
  }
  const gen = spawn("npx", ["prisma", "generate"], { cwd: root, stdio: "inherit", shell: true });
  gen.on("exit", (c) => process.exit(c ?? 0));
}

const cmd = process.argv[2] || "which";
if (cmd === "which") cmdWhich();
else if (cmd === "start") cmdStart(process.argv[3]);
else if (cmd === "stop") cmdStop();
else if (cmd === "migrate") cmdMigrate(process.argv[3], process.argv.includes("--force"));
else if (cmd === "predev") cmdPredev();
else {
  console.error(`未知命令：${cmd}（可用：which / start / stop / migrate / predev）`);
  process.exit(1);
}
