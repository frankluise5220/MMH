#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = process.env.FNOS_PACKAGE_VERSION || pkg.version || "0.1.0";
const outDir = path.join(root, "release-artifacts", "fnos");
const stageDir = path.join(outDir, "mmh-fpk");
const stageOnly = process.argv.includes("--stage-only");

function mkdirp(target) {
  fs.mkdirSync(target, { recursive: true });
}

function write(file, content, mode) {
  mkdirp(path.dirname(file));
  fs.writeFileSync(file, content.replace(/\r\n/g, "\n"), "utf8");
  if (mode) fs.chmodSync(file, mode);
}

function copy(src, dest) {
  mkdirp(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd || root,
    stdio: options.stdio || "pipe",
    shell: false,
    encoding: "utf8",
  });
}

function hasCommand(command) {
  const probe = process.platform === "win32"
    ? run("where.exe", [command])
    : run("sh", ["-lc", `command -v ${command}`]);
  return probe.status === 0;
}

fs.rmSync(stageDir, { recursive: true, force: true });
mkdirp(stageDir);

for (const dir of ["app/docker", "app/ui/images", "cmd", "config", "wizard"]) {
  mkdirp(path.join(stageDir, dir));
}

write(path.join(stageDir, "manifest"), `
appname=mmh
version=${version}
desc=一套本地部署、致力于化繁为简的家庭账务管理系统。
display_name=MMH
arch=x86_64
source=thirdparty
maintainer=frankluise5220
maintainer_url=https://github.com/frankluise5220/MMH
distributor=frankluise5220
distributor_url=https://github.com/frankluise5220/MMH
helpurl=https://github.com/frankluise5220/MMH
desktop_uidir=ui
desktop_applaunchname=mmh.Application
service_port=7777
checkport=true
`);

write(path.join(stageDir, "config", "privilege"), JSON.stringify({
  defaults: { "run-as": "package" },
  username: "docker-mmh",
  groupname: "docker-mmh",
}, null, 2));

write(path.join(stageDir, "config", "resource"), JSON.stringify({
  "docker-project": {
    projects: [
      {
        name: "mmh",
        path: "docker",
      },
    ],
  },
  "data-share": {
    shares: [
      {
        name: "mmh",
        permission: {
          rw: ["docker-mmh"],
        },
      },
      {
        name: "mmh/data",
        permission: {
          rw: ["docker-mmh"],
        },
      },
    ],
  },
}, null, 2));
write(path.join(stageDir, "wizard", "install"), JSON.stringify([], null, 2));
write(path.join(stageDir, "app", "ui", "config"), JSON.stringify({
  ".url": {
    "mmh.Application": {
      title: "MMH",
      icon: "images/icon_{0}.png",
      type: "url",
      protocol: "http",
      port: "7777",
      url: "/",
      allUsers: false,
    },
  },
}, null, 2));

copy(path.join(root, "deploy", "fnos", "docker-compose.yml"), path.join(stageDir, "app", "docker", "docker-compose.yaml"));
copy(path.join(root, "deploy", "fnos", "env.example"), path.join(stageDir, "app", "docker", "env.example"));
copy(path.join(root, "deploy", "fnos", "postgres-entrypoint.sh"), path.join(stageDir, "app", "docker", "postgres-entrypoint.sh"));

const markIcon = path.join(root, "public", "branding", "mmh-logo-mark.preview.png");
const wideIcon = path.join(root, "public", "branding", "mmh-logo-horizontal.preview.png");
copy(markIcon, path.join(stageDir, "ICON.PNG"));
copy(wideIcon, path.join(stageDir, "ICON_256.PNG"));
copy(markIcon, path.join(stageDir, "app", "ui", "images", "icon_64.png"));
copy(wideIcon, path.join(stageDir, "app", "ui", "images", "icon_256.png"));

write(path.join(stageDir, "cmd", "main"), `#!/bin/bash

is_docker_running () {
  docker inspect mmh-app | grep -q "\\"Status\\": \\"running\\"," || exit 1
}

case "\${1:-status}" in
start)
  # Docker applications are started by fnOS appcenter.
  exit 0
  ;;
stop)
  # Docker applications are stopped by fnOS appcenter.
  exit 0
  ;;
status)
  if is_docker_running; then
    exit 0
  else
    exit 3
  fi
  ;;
*)
  exit 1
  ;;
esac
`, 0o755);

const lifecycle = `#!/bin/bash

exit 0
`;

for (const name of [
  "install_init",
  "install_callback",
  "upgrade_init",
  "upgrade_callback",
  "uninstall_init",
  "uninstall_callback",
  "config_init",
  "config_callback",
]) {
  write(path.join(stageDir, "cmd", name), lifecycle, 0o755);
}

console.log(`FNOS FPK source staged: ${path.relative(root, stageDir)}`);

if (stageOnly) {
  const archive = path.join(outDir, `mmh-${version}-fnos-fpk-source.tgz`);
  const tar = run("tar", ["-czf", archive, "-C", stageDir, "."]);
  if (tar.status !== 0) {
    console.error(tar.stderr || tar.stdout || "tar failed");
    process.exit(tar.status || 1);
  }
  console.log(`FNOS stage-only archive: ${path.relative(root, archive)}`);
  console.log("This archive is not a release package. Use it only for fnOS install-local/debugging.");
  process.exit(0);
}

if (!hasCommand("fnpack")) {
  console.error("fnpack was not found. A releaseable fnOS package must be a .fpk file.");
  console.error("Install fnpack or run this script on a fnOS packaging environment.");
  console.error("For debugging only, run: node scripts/build-fnos-package.cjs --stage-only");
  process.exit(1);
}

const build = run("fnpack", ["build"], { cwd: stageDir, stdio: "inherit" });
if (build.status !== 0) process.exit(build.status || 1);

const produced = path.join(stageDir, "mmh.fpk");
if (!fs.existsSync(produced)) {
  console.error("fnpack completed but did not produce mmh.fpk.");
  process.exit(1);
}

const fpkPath = path.join(outDir, `mmh-${version}-x86_64.fpk`);
copy(produced, fpkPath);
console.log(`FNOS FPK built: ${path.relative(root, fpkPath)}`);
