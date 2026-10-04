#!/usr/bin/env node

const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const appName = "mmh";
const rawVersion = process.env.SYNOLOGY_PACKAGE_VERSION || process.env.SYNOPKG_PACKAGE_VERSION || pkg.version || "0.1.0";
const version = normalizeVersion(rawVersion);
const target = normalizeTarget(process.env.SYNOLOGY_TARGET_ARCH || process.env.SYNOPKG_TARGET_ARCH || "x86_64");
const outDir = path.join(root, "release-artifacts", "synology");
const stageDir = path.join(outDir, target.stageDirName);
const packageRoot = path.join(stageDir, "package");
const stageOnly = process.argv.includes("--stage-only");
const nodeTarball = process.env.SYNOLOGY_NODE_TARBALL || process.env.SYNOPKG_NODE_TARBALL || process.env.FNOS_NODE_TARBALL || "";
const reusePackageTgz = process.env.SYNOLOGY_REUSE_PACKAGE_TGZ || "";
const packageReleaseNotes = typeof pkg.mmhReleaseNotes === "string" ? pkg.mmhReleaseNotes.trim() : "";
const dsmMinVersion = "7.0-40000";
const dsmAppName = "com.synocommunity.packages.mmh";
// DSM reads the desktop-app registration from "<PKGDEST>/<dsmuidir>/config" and the
// app icons from "<PKGDEST>/<dsmuidir>/images". Without `dsmuidir` in INFO the UI
// directory is never mounted, so Package Center shows no "打开" button and no icon.
const dsmUiDir = "ui";
const dsmIconSizes = [16, 24, 32, 48, 64, 72, 256];
const adminPort = process.env.SYNOLOGY_ADMIN_PORT || "7777";

if (!/^([1-9][0-9]{0,4})$/.test(adminPort) || Number(adminPort) > 65535) {
  throw new Error(`SYNOLOGY_ADMIN_PORT must be a TCP port between 1 and 65535, got ${adminPort}.`);
}

function normalizeVersion(value) {
  const raw = String(value || "").trim();
  const normalized = raw.replace(/^refs\/tags\//, "").replace(/^v(?=\d)/, "").replace(/-synology(?:$|[.-].*)?$/, "");
  if (!/^0\.1\.\d+$/.test(normalized)) {
    throw new Error(`SYNOLOGY_PACKAGE_VERSION must use 0.1.x format, got ${normalized || "(empty)"}.`);
  }
  return normalized;
}

function normalizeTarget(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/_/g, "-");
  if (["", "x86", "x86-64", "x64", "amd64"].includes(raw)) {
    return {
      id: "x86_64",
      assetSuffix: "x86_64",
      infoArch: "x86_64",
      nodeArch: "x64",
      processArch: "x64",
      fnosTarget: "x86",
      fnosStageDirName: "mmh-fpk",
      stageDirName: "mmh-spk",
    };
  }
  if (["arm", "arm64", "aarch64", "armv8"].includes(raw)) {
    return {
      id: "arm64",
      assetSuffix: "arm64",
      infoArch: "aarch64",
      nodeArch: "arm64",
      processArch: "arm64",
      fnosTarget: "arm64",
      fnosStageDirName: "mmh-arm64-fpk",
      stageDirName: "mmh-arm64-spk",
    };
  }
  throw new Error(`SYNOLOGY_TARGET_ARCH must be x86_64 or arm64, got ${value || "(empty)"}.`);
}

function mkdirp(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function write(file, content, mode) {
  mkdirp(path.dirname(file));
  fs.writeFileSync(file, content.replace(/\r\n/g, "\n"), "utf8");
  if (mode) fs.chmodSync(file, mode);
}

function copyFile(src, dest) {
  mkdirp(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function readPngRgba(file) {
  const input = fs.readFileSync(file);
  if (input.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error(`${path.relative(root, file)} is not a PNG file.`);
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks = [];
  while (offset < input.length) {
    const length = input.readUInt32BE(offset);
    const type = input.subarray(offset + 4, offset + 8).toString("ascii");
    const data = input.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`${path.relative(root, file)} must be an 8-bit RGB or RGBA PNG.`);
  }

  const sourceBpp = colorType === 6 ? 4 : 3;
  const rowLength = width * sourceBpp;
  const inflated = zlib.inflateSync(Buffer.concat(idatChunks));
  const rgba = Buffer.alloc(width * height * 4);
  let readOffset = 0;
  let previous = Buffer.alloc(rowLength);
  const paeth = (left, up, upLeft) => {
    const value = left + up - upLeft;
    const pa = Math.abs(value - left);
    const pb = Math.abs(value - up);
    const pc = Math.abs(value - upLeft);
    if (pa <= pb && pa <= pc) return left;
    return pb <= pc ? up : upLeft;
  };

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[readOffset];
    readOffset += 1;
    const row = Buffer.from(inflated.subarray(readOffset, readOffset + rowLength));
    readOffset += rowLength;
    for (let x = 0; x < rowLength; x += 1) {
      const left = x >= sourceBpp ? row[x - sourceBpp] : 0;
      const up = previous[x] ?? 0;
      const upLeft = x >= sourceBpp ? previous[x - sourceBpp] : 0;
      if (filter === 1) row[x] = (row[x] + left) & 0xff;
      else if (filter === 2) row[x] = (row[x] + up) & 0xff;
      else if (filter === 3) row[x] = (row[x] + Math.floor((left + up) / 2)) & 0xff;
      else if (filter === 4) row[x] = (row[x] + paeth(left, up, upLeft)) & 0xff;
      else if (filter !== 0) throw new Error(`${path.relative(root, file)} uses unsupported PNG filter ${filter}.`);
    }
    for (let x = 0; x < width; x += 1) {
      const sourceOffset = x * sourceBpp;
      const targetOffset = (y * width + x) * 4;
      rgba[targetOffset] = row[sourceOffset];
      rgba[targetOffset + 1] = row[sourceOffset + 1];
      rgba[targetOffset + 2] = row[sourceOffset + 2];
      rgba[targetOffset + 3] = sourceBpp === 4 ? row[sourceOffset + 3] : 0xff;
    }
    previous = row;
  }
  return { width, height, rgba };
}

function resizeRgbaNearestBox(image, size) {
  const output = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const yStart = Math.floor((y * image.height) / size);
    const yEnd = Math.max(yStart + 1, Math.floor(((y + 1) * image.height) / size));
    for (let x = 0; x < size; x += 1) {
      const xStart = Math.floor((x * image.width) / size);
      const xEnd = Math.max(xStart + 1, Math.floor(((x + 1) * image.width) / size));
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      let count = 0;
      for (let sourceY = yStart; sourceY < yEnd; sourceY += 1) {
        for (let sourceX = xStart; sourceX < xEnd; sourceX += 1) {
          const sourceOffset = (sourceY * image.width + sourceX) * 4;
          red += image.rgba[sourceOffset];
          green += image.rgba[sourceOffset + 1];
          blue += image.rgba[sourceOffset + 2];
          alpha += image.rgba[sourceOffset + 3];
          count += 1;
        }
      }
      const targetOffset = (y * size + x) * 4;
      output[targetOffset] = Math.round(red / count);
      output[targetOffset + 1] = Math.round(green / count);
      output[targetOffset + 2] = Math.round(blue / count);
      output[targetOffset + 3] = Math.round(alpha / count);
    }
  }
  return output;
}

function writeRgbaPng(file, size, rgba) {
  mkdirp(path.dirname(file));
  const signature = Buffer.from("89504e470d0a1a0a", "hex");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    rows.push(Buffer.from([0]));
    rows.push(rgba.subarray(y * size * 4, (y + 1) * size * 4));
  }
  fs.writeFileSync(file, Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]));
}

function copyIcon(src, dest, size) {
  const image = readPngRgba(src);
  writeRgbaPng(dest, size, resizeRgbaNearestBox(image, size));
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.cpSync(src, dest, { recursive: true });
  return true;
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd || root,
    stdio: options.stdio || "pipe",
    shell: false,
    encoding: "utf8",
    env: options.env ? { ...process.env, ...options.env } : process.env,
  });
}

function commandName(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function requirePath(targetPath, message) {
  if (!fs.existsSync(targetPath)) throw new Error(message);
}

function hashFileMd5(file) {
  const hash = crypto.createHash("md5");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function setTarEntryModes(file, executableEntries, compressed) {
  let archive = fs.readFileSync(file);
  if (compressed) archive = zlib.gunzipSync(archive);
  const names = new Set(executableEntries);
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "").replace(/^\.\//, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const entryName = (prefix ? `${prefix}/${name}` : name).replace(/^\.\//, "");
    const sizeRaw = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
    const size = sizeRaw ? Number.parseInt(sizeRaw, 8) : 0;
    if (names.has(entryName)) {
      header.fill(0, 100, 108);
      header.write("0000755\0", 100, "ascii");
      header.fill(0x20, 148, 156);
      let checksum = 0;
      for (const byte of header) checksum += byte;
      header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (compressed) archive = zlib.gzipSync(archive);
  fs.writeFileSync(file, archive);
}

function directorySizeKb(dir) {
  let bytes = 0;
  const walk = (current) => {
    const stat = fs.lstatSync(current);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) walk(path.join(current, entry));
      return;
    }
    if (stat.isFile()) bytes += stat.size;
  };
  walk(dir);
  return Math.max(1, Math.ceil(bytes / 1024));
}

function tarOwnerArgs() {
  return process.platform === "win32" ? [] : ["--owner=0", "--group=0", "--numeric-owner"];
}

function makeReadable(dir) {
  if (!fs.existsSync(dir)) return;
  const walk = (current) => {
    const stat = fs.lstatSync(current);
    if (stat.isDirectory()) {
      fs.chmodSync(current, 0o755);
      for (const entry of fs.readdirSync(current)) walk(path.join(current, entry));
      return;
    }
    if (!stat.isFile()) return;
    const relative = path.relative(stageDir, current).replace(/\\/g, "/");
    const executable =
      relative.startsWith("scripts/") ||
      relative === "package/app/bin/node" ||
      relative.startsWith("package/app/bin/bin/");
    fs.chmodSync(current, executable ? 0o755 : 0o644);
  };
  walk(dir);
}

function findNodeHeadersDir() {
  const candidates = [
    path.dirname(path.dirname(process.execPath)),
    "/usr/local",
    "/usr",
  ];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, "include", "node", "node.h"))) || "";
}

function spkAssetName() {
  return `${appName}-synology-v${version}-${target.assetSuffix}.spk`;
}

function runFnosStage() {
  if (process.env.SYNOLOGY_SKIP_FNOS_STAGE === "1") {
    console.log("Reusing the existing fnOS stage for Synology packaging.");
    return;
  }
  if (!nodeTarball) {
    throw new Error(`Provide a Linux ${target.nodeArch} Node runtime tarball with SYNOLOGY_NODE_TARBALL before building ${spkAssetName()}.`);
  }
  if (!path.basename(nodeTarball).includes(`linux-${target.nodeArch}`)) {
    throw new Error(`SYNOLOGY_NODE_TARBALL must match ${target.id}: expected a linux-${target.nodeArch} tarball.`);
  }
  const result = run(process.execPath, [path.join(root, "scripts", "build-fnos-package.cjs"), "--stage-only"], {
    stdio: "inherit",
    env: {
      FNOS_TARGET_ARCH: target.fnosTarget,
      FNOS_NODE_TARBALL: nodeTarball,
      FNOS_PACKAGE_VERSION: version,
    },
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

function runSynologyAppBuild() {
  const result = run(process.execPath, [path.join(root, "scripts", "build-synology-app.cjs")], {
    stdio: "inherit",
    env: {
      MMH_BASE_PATH: "",
      MMH_DEPLOY_TARGET: "synology",
    },
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

function writeInfoFile(options = {}) {
  const checksumLine = options.checksum ? `checksum="${options.checksum}"\n` : "";
  const extractSizeLine = options.extractSizeKb ? `extractsize="${options.extractSizeKb}"\n` : "";
  write(path.join(stageDir, "INFO"), `package="${appName}"
version="${version}"
displayname="MMH"
description="家庭记账与财务管理应用，使用本地 SQLite 数据库，无需 Docker 或 PostgreSQL。安装后通过浏览器访问；卸载时可选择保留或删除数据库与设置。"
maintainer="frankluise5220"
support_url="https://github.com/frankluise5220/MMH"
dsmappname="${dsmAppName}"
dsmuidir="${dsmUiDir}"
arch="${target.infoArch}"
os_min_ver="${dsmMinVersion}"
${checksumLine}${extractSizeLine}thirdparty="yes"
startable="yes"
ctl_stop="yes"
silent_install="no"
silent_upgrade="no"
silent_uninstall="no"
`);
}

// ---------------------------------------------------------------------------
// Port wizard (install + upgrade)
//
// DSM renders `WIZARD_UIFILES/<name>_uifile` (static JSON) or, when
// `<name>_uifile.sh` exists, runs that script and reads the JSON it writes to
// $SYNOPKG_TEMP_LOGFILE. A static file cannot tell the user that the port they
// are about to pick is already owned by someone else - which is exactly why the
// installer looked like it silently accepted a 7777 that the Docker build was
// holding. Both files are shipped: the `.sh` adds the live occupancy report and
// pre-fills the next free port, the static file keeps the wizard renderable if
// DSM reads it instead.
// ---------------------------------------------------------------------------
const wizardPortRegex = "/^([1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$/";

function wizardJson(desc) {
  return JSON.stringify([{
    step_title: "MMH 网络端口",
    invalid_next_disabled: true,
    items: [{
      type: "textfield",
      subitems: [{
        key: "wizard_port",
        desc,
        defaultValue: adminPort,
        validator: {
          allowBlank: false,
          regex: {
            expr: wizardPortRegex,
            errorText: "请输入 1 到 65535 之间的端口号",
          },
        },
      }],
    }],
  }], null, 2);
}

// The dynamic wizard scripts assemble their JSON from these fragments with
// printf, so that no shell quoting or sed escaping can ever corrupt it. The
// fragments are validated at build time below - a missing bracket used to ship
// silently and leave the DSM wizard blank.
const wizardJsonHead = '[{"step_title":"MMH 网络端口","invalid_next_disabled":true,"items":[{"type":"textfield","subitems":[{"key":"wizard_port","desc":"';
const wizardJsonMid = '","defaultValue":"';
const wizardJsonTail = `","validator":{"allowBlank":false,"regex":{"expr":"${wizardPortRegex}","errorText":"请输入 1 到 65535 之间的端口号"}}}]}]}]`;

function assertWizardJsonFragments() {
  const sample = `${wizardJsonHead}DESC${wizardJsonMid}${adminPort}${wizardJsonTail}`;
  let parsed;
  try {
    parsed = JSON.parse(sample);
  } catch (error) {
    throw new Error(`Synology wizard JSON fragments do not assemble into valid JSON: ${error.message}`);
  }
  const subitem = parsed?.[0]?.items?.[0]?.subitems?.[0];
  if (subitem?.key !== "wizard_port" || subitem?.defaultValue !== adminPort) {
    throw new Error("Synology wizard JSON fragments lost the wizard_port field.");
  }
  const staticSample = JSON.parse(wizardJson("DESC"));
  if (JSON.stringify(staticSample) !== JSON.stringify(parsed)) {
    throw new Error("Synology static and dynamic wizard JSON must describe the same field.");
  }
}
assertWizardJsonFragments();

// Shared shell body of the dynamic wizard scripts. `resolveDefault` prints the
// port the wizard should start from; `suffix` is appended to the description
// when the port is free; `ownDesc` replaces the description when the port is
// held by this package's own running instance.
//
// Every description is deliberately ONE short sentence. DSM renders it as a
// full-width block under the step title, it DOES wrap, and the dialog height is
// fixed -- so a long text is truncated mid-sentence rather than expanding the
// window. The previous three-sentence version ("端口 7779 已被占用（pid=32095
// (next-server (v1），已预填下一个可用端口 7780。更新会沿用当前端口；如需更换
// 端口，在此填写新端口即可。" plus a warning emoji, 87 characters) was cut off
// after the second line on DSM 7.2. `check:synology` asserts both a length
// budget and the absence of that emoji.
function wizardScriptBody(resolveDefault, suffix, ownDesc) {
  if (!suffix || !ownDesc) {
    throw new Error("wizardScriptBody needs both a free-port suffix and an own-instance description; a missing one ships as desc=\"undefined\" in the DSM wizard.");
  }
  return `OUT="\${SYNOPKG_TEMP_LOGFILE:-}"
[ -n "$OUT" ] || exit 0

port="$(${resolveDefault})"
case "$port" in
  ''|*[!0-9]*) port="$DEFAULT_PORT" ;;
esac

if port_is_listening "$port"; then
  # Listening is NOT the same as conflicting. While DSM renders this wizard the
  # previous MMH is still running (DSM stops it only after the wizard), so on an
  # upgrade - and on a reinstall over a running install - the listener on the
  # persisted port is this very package. The upgrade reuses that port, so this
  # branch must keep it instead of advancing to the next free one.
  owner_pids="$(port_listener_pids "$port")"
  own_only=""
  if [ -n "$owner_pids" ]; then
    own_only=1
    for pid in $owner_pids; do
      if ! is_own_mmh_listener "$pid"; then
        own_only=0
        break
      fi
    done
  fi
  if [ "$own_only" = "1" ]; then
    desc="${ownDesc}"
  else
    owner="$(port_owner_short "$port" | sed 's/[\\\\"]//g' | cut -c1-16)"
    if free_port="$(probe_free_port \$((port + 1)))"; then
      desc="端口 $port 被占用（$owner），已预填 $free_port。"
      port="$free_port"
    else
      desc="端口 $port 被占用（$owner），请填写其他端口。"
    fi
  fi
else
  desc="当前端口 $port 可用。${suffix}"
fi
desc="$(printf '%s' "$desc" | sed 's/[\\\\"]//g')"

# Record the port this wizard just pre-filled. postinst compares the submitted
# value against it and honours the wizard ONLY when the user typed something
# different, so a wizard that silently fell back to the static JSON default
# (7777) can never move a live install off the port it is already using.
# The wizard runs before the package is unpacked, so $SYNOPKG_PKGVAR is the
# only writable channel; preinst and postinst read it, postinst removes it.
# See docs/product-todos.md ("精确版 A" = option C).
WIZARD_PORT_RECORD="\${SYNOPKG_PKGVAR:-/var/packages/$PACKAGE/var}/mmh-wizard-port"
mkdir -p "\$(dirname "$WIZARD_PORT_RECORD")" 2>/dev/null || true
printf '%s\\n' "$port" > "$WIZARD_PORT_RECORD" 2>/dev/null || true

printf '%s' '${wizardJsonHead}' > "$OUT" 2>/dev/null || true
printf '%s' "$desc" >> "$OUT" 2>/dev/null || true
printf '%s' '${wizardJsonMid}' >> "$OUT" 2>/dev/null || true
printf '%s' "$port" >> "$OUT" 2>/dev/null || true
printf '%s' '${wizardJsonTail}' >> "$OUT" 2>/dev/null || true
exit 0`;
}

const installWizardSuffix = "首次安装将使用该端口。";
const upgradeWizardSuffix = "升级会沿用当前端口。";
const installWizardOwnDesc = "端口 $port 由 MMH 自身占用，安装后会继续沿用。";
const upgradeWizardOwnDesc = "端口 $port 由 MMH 自身占用，升级后会继续沿用。";

function writeInstallWizard() {
  write(path.join(stageDir, "WIZARD_UIFILES", "install_uifile"), wizardJson(installWizardSuffix));
  write(path.join(stageDir, "WIZARD_UIFILES", "install_uifile.sh"), `#!/bin/sh
# DSM runs this before rendering the install wizard and reads the wizard JSON
# from $SYNOPKG_TEMP_LOGFILE. Probing here is the only chance to tell the user
# that their chosen port is already taken BEFORE they press 下一步.
# Never exits non-zero: a failing wizard script leaves the whole wizard blank.

PACKAGE="mmh"
DEFAULT_PORT=${adminPort}
OWN_SERVER_JS="/var/packages/$PACKAGE/target/app/server/server.js"

${portIdentityShell}

${portProbeShell}

${wizardScriptBody(`printf '%s' "$DEFAULT_PORT"`, installWizardSuffix, installWizardOwnDesc)}`, 0o755);
}

function writeUpgradeWizard() {
  write(path.join(stageDir, "WIZARD_UIFILES", "upgrade_uifile"), wizardJson(upgradeWizardSuffix));
  write(path.join(stageDir, "WIZARD_UIFILES", "upgrade_uifile.sh"), `#!/bin/sh
# Upgrade counterpart of install_uifile.sh. Starting from the port that is
# already persisted keeps an upgrade on the port the user is already using, and
# the port the wizard pre-fills is recorded in mmh-wizard-port so postinst can
# tell "the user typed a new port" from "this is just the default we proposed".
# Leaving the field untouched therefore changes nothing, while editing it does
# move the install - see docs/product-todos.md ("精确版 A" = option C).

PACKAGE="mmh"
DEFAULT_PORT=${adminPort}
OWN_SERVER_JS="/var/packages/$PACKAGE/target/app/server/server.js"
VAR_DIR="\${SYNOPKG_PKGVAR:-/var/packages/$PACKAGE/var}"
ENV_FILE="$VAR_DIR/mmh.env"

${portIdentityShell}

${portProbeShell}

${wizardScriptBody(`sed -n 's/^PORT=//p' "$ENV_FILE" 2>/dev/null | head -n 1 | tr -d '[:space:]'`, upgradeWizardSuffix, upgradeWizardOwnDesc)}`, 0o755);
}

function writeUninstallWizard() {
  write(path.join(stageDir, "WIZARD_UIFILES", "uninstall_uifile"), JSON.stringify([{
    step_title: "卸载 MMH",
    items: [{
      type: "singleselect",
      desc: "选择是否保留 MMH 数据。保留后重新安装可继续使用原有账簿。",
      subitems: [{
        key: "wizard_keep_data",
        desc: "保留数据库和设置（推荐）",
        defaultValue: true,
      }, {
        key: "wizard_delete_data",
        desc: "删除数据库和设置（不可恢复）",
        defaultValue: false,
      }],
    }],
  }], null, 2));
}

// How "is this listener our own package?" is decided. This is shared by every
// script that has to tell our own running MMH apart from a foreign owner
// (preinst, postinst, start-stop-status, config and both wizard scripts).
//
// Do NOT go back to matching `/proc/<pid>/cmdline` against
// ".../app/server/server.js": that never matches on a real DSM install, and
// misclassifying our own process is what made the upgrade wizard report
// "7779 已被占用" and pre-fill 7780 while the port was held by the very version
// being upgraded (reported 2026-09-30 on 192.168.2.148, DSM 7.2). Two reasons,
// both verified on that machine:
//
//   1. Next.js standalone rewrites argv[0] at startup
//      (`process.title = "next-server (vX.Y.Z)"`,
//      node_modules/next/dist/esm/server/lib/start-server.js), so cmdline reads
//      "next-server (v16.2.6)" and the server.js path is gone.
//   2. `/var/packages/<pkg>/target` is a symlink to `/volumeX/@appstore/<pkg>`,
//      so `readlink /proc/<pid>/exe` yields
//      `/volume1/@appstore/mmh/app/bin/node` and never equals the unresolved
//      `$APP_DIR/app/bin/node`.
//
// What survives both rewrites is DSM's own cgroup: every process belonging to a
// package runs under "<pkg>.slice/pkgctl-<pkg>.service" (observed:
// "2:name=synomonitor:/mmh.slice/pkgctl-mmh.service"). It is world-readable and
// names the owning package, so it cannot be spoofed by another package or by a
// container. `process_is_containerized` is still evaluated first so a
// Docker-hosted MMH (including host-network containers) stays foreign.
const portIdentityShell = `process_is_containerized() {
  pid="$1"
  [ -r "/proc/$pid/cgroup" ] || return 1
  grep -Eq "(^|[/:.])docker([/.]|$)|docker-proxy|/lxc/|containerd|/kubepods" "/proc/$pid/cgroup" 2>/dev/null
}

process_belongs_to_package() {
  pid="$1"
  [ -r "/proc/$pid/cgroup" ] || return 1
  grep -Eq "(^|[/:])pkgctl-$PACKAGE(\\.service)?($|/)|(^|[/:])$PACKAGE\\.slice($|/)" "/proc/$pid/cgroup" 2>/dev/null
}

# Fallback for a DSM that renames the package cgroup: the bundled runtime lives
# at <pkg>/target/app/bin/node, which resolves to
# /volumeX/@appstore/<pkg>/app/bin/node, and the legacy cmdline match is kept for
# an install whose server never rewrote its title.
process_runs_our_server() {
  pid="$1"
  exe="$(readlink "/proc/$pid/exe" 2>/dev/null || true)"
  case "$exe" in
    */@appstore/$PACKAGE/app/bin/node|*/$PACKAGE/target/app/bin/node) return 0 ;;
  esac
  cmdline="$(tr '\\000' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  case "$cmdline" in
    *"$OWN_SERVER_JS"*) return 0 ;;
  esac
  return 1
}`;

// Shared POSIX-sh helpers for install-time port inspection. DSM ships busybox
// sh (no /dev/tcp), so listener discovery reads the socket inode column from
// /proc/net/tcp* and maps inodes back to PIDs through /proc/<pid>/fd. Only a
// process running THIS package's bundled server (and not inside a container)
// counts as "our own"; Docker port mappings, Docker-hosted MMH, other packages
// and unrelated services all count as "someone else".
const portProbeShell = `port_listener_inodes() {
  port="$1"
  port_hex="$(printf '%04X' "$port" 2>/dev/null)" || return 1
  for table in /proc/net/tcp /proc/net/tcp6; do
    [ -r "$table" ] || continue
    awk -v wanted="$port_hex" '
      NR > 1 {
        split($2, endpoint, ":")
        if (toupper(endpoint[2]) == wanted && $4 == "0A") print $10
      }
    ' "$table"
  done
}

port_is_listening() {
  port="$1"
  case "$port" in
    ""|*[!0-9]*) return 1 ;;
  esac
  port_listener_inodes "$port" | grep . >/dev/null 2>&1 && return 0
  if command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | awk -v port="$port" '
      {
        address=$4
        sub(/^.*:/, "", address)
        if (address == port) found=1
      }
      END { exit(found ? 0 : 1) }
    '
    return $?
  fi
  return 1
}

# Walk forward from $1 until a TCP port that nothing is listening on shows up.
# Used by the install wizard (to pre-fill a usable default) and by postinst
# (to move an occupied port out of the way) so both agree on the same rule.
probe_free_port() {
  candidate="$1"
  tries=0
  while [ "$tries" -lt 200 ]; do
    if ! port_is_listening "$candidate"; then
      printf '%s' "$candidate"
      return 0
    fi
    candidate=$((candidate + 1))
    tries=$((tries + 1))
  done
  return 1
}

# Human readable owner of whatever holds $1, so the wizard can name the
# conflicting program instead of just saying "something is using it".
port_owner_text() {
  for pid in $(port_listener_pids "$1"); do
    printf '%s' "$(describe_port_owner "$pid")"
    return 0
  done
  printf '%s' "未知进程"
}

# Owner label for the DSM wizard description. DSM renders that description as a
# full-width block under the step title, it wraps, and the dialog height is fixed
# -- so anything long gets truncated mid-sentence (an 87-character string did).
# Keep this short; describe_port_owner()'s long form ("Docker 端口映射 pid=1234
# (docker-proxy)") belongs in preinst's log line instead. Hard-capped at 16 chars.
port_owner_short() {
  for pid in $(port_listener_pids "$1"); do
    if process_is_containerized "$pid"; then
      printf 'Docker pid=%s' "$pid"
      return 0
    fi
    case "$(tr '\\000' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)" in
      *docker-proxy*) printf 'Docker 映射' ;;
      *) printf 'pid=%s' "$pid" ;;
    esac
    return 0
  done
  printf '未知进程'
}

port_listener_pids() {
  port="$1"
  inodes=" $(port_listener_inodes "$port" | tr '\\n' ' ') "
  case "$inodes" in
    *[!0-9\\ ]*) return 0 ;;
  esac
  for pid_dir in /proc/[0-9]*; do
    [ -d "$pid_dir" ] || continue
    pid="\${pid_dir#/proc/}"
    for fd in "$pid_dir"/fd/*; do
      link="$(readlink "$fd" 2>/dev/null || true)"
      case "$link" in
        socket:\\[*\\])
          inode="\${link#socket:[}"
          inode="\${inode%]}"
          case "$inodes" in
            *" $inode "*)
              printf '%s\\n' "$pid"
              break
              ;;
          esac
          ;;
      esac
    done
  done
}

describe_port_owner() {
  pid="$1"
  comm="$(tr -d '\\n' < "/proc/$pid/comm" 2>/dev/null || true)"
  if process_is_containerized "$pid"; then
    printf "Docker/容器进程 pid=%s (%s)" "$pid" "\${comm:-unknown}"
    return 0
  fi
  cmdline="$(tr '\\000' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  case "$cmdline" in
    *docker-proxy*)
      printf "Docker 端口映射 pid=%s (docker-proxy)" "$pid"
      ;;
    *)
      if is_own_mmh_listener "$pid"; then
        printf "MMH 套件进程 pid=%s" "$pid"
      else
        printf "pid=%s (%s)" "$pid" "\${comm:-unknown}"
      fi
      ;;
  esac
}

is_own_mmh_listener() {
  pid="$1"
  process_is_containerized "$pid" && return 1
  process_belongs_to_package "$pid" && return 0
  process_runs_our_server "$pid"
}

read_installed_port() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n 's/^PORT=//p' "$ENV_FILE" 2>/dev/null | head -n 1 | tr -d '[:space:]'
}`;

// `preinst` runs before the package is unpacked. A non-zero exit aborts the
// installation cleanly (unlike `postinst`, which would leave the package in a
// corrupted state), so this is where an externally occupied port must be
// rejected with an actionable message.
function writePreinstScript() {
  write(path.join(stageDir, "scripts", "preinst"), `#!/bin/sh

PACKAGE="mmh"
APP_DIR="\${SYNOPKG_PKGDEST:-/var/packages/$PACKAGE/target}"
VAR_DIR="\${SYNOPKG_PKGVAR:-/var/packages/$PACKAGE/var}"
ENV_FILE="$VAR_DIR/mmh.env"
OWN_SERVER_JS="/var/packages/$PACKAGE/target/app/server/server.js"
DEFAULT_PORT=${adminPort}

${portIdentityShell}

${portProbeShell}

report_preinst_message() {
  if [ -n "\${SYNOPKG_TEMP_LOGFILE:-}" ]; then
    printf '%s\\n' "$*" >>"\$SYNOPKG_TEMP_LOGFILE" 2>/dev/null || true
  fi
  printf '%s\\n' "$*" >&2
}

# The wizard pre-fills the port an upgrade would otherwise keep, so a submitted
# value only counts as a user selection when it DIFFERS from the port the
# wizard itself proposed (recorded in mmh-wizard-port). Without that record -
# a wizard that fell back to the static JSON default, or no wizard at all - an
# upgrade keeps the port already persisted. Mirrors postinst; see
# docs/product-todos.md ("精确版 A" = option C).
wizard_port_value="$(printf '%s' "\${wizard_port:-}" | tr -d '[:space:]')"
case "$wizard_port_value" in
  ""|*[!0-9]*) wizard_port_value="" ;;
esac
wizard_recorded_port="$(cat "$VAR_DIR/mmh-wizard-port" 2>/dev/null | tr -d '[:space:]')"
case "$wizard_recorded_port" in
  ""|*[!0-9]*) wizard_recorded_port="" ;;
esac

target_port=""
port_source="installer selection"
if [ -n "$wizard_port_value" ] && [ -n "$wizard_recorded_port" ] && [ "$wizard_port_value" != "$wizard_recorded_port" ]; then
  target_port="$wizard_port_value"
fi
if [ -z "$target_port" ]; then
  target_port="$(read_installed_port)"
  if [ -n "$target_port" ]; then
    port_source="existing installation"
  fi
fi
case "$target_port" in
  ""|*[!0-9]*)
    target_port="$DEFAULT_PORT"
    port_source="package default"
    ;;
esac
if [ "$target_port" -lt 1 ] || [ "$target_port" -gt 65535 ]; then
  report_preinst_message "MMH installation aborted: port $target_port is not a valid TCP port between 1 and 65535."
  exit 1
fi

if ! port_is_listening "$target_port"; then
  exit 0
fi

conflict_pid=""
for pid in $(port_listener_pids "$target_port"); do
  if is_own_mmh_listener "$pid"; then
    continue
  fi
  conflict_pid="$pid"
  break
done

if [ -z "$conflict_pid" ]; then
  # Every listener belongs to this package (e.g. an upgrade whose old process
  # has not exited yet). The start script handles that case.
  exit 0
fi

owner="$(describe_port_owner "$conflict_pid")"
report_preinst_message "MMH 安装提示：端口 $target_port 已被其他程序占用（$owner，$port_source），安装会继续，并在完成后自动改用后续可用的端口。"
report_preinst_message "MMH note: TCP port $target_port is already in use by another program ($owner, $port_source); installation continues and will switch to the next free port."
report_preinst_message "如需固定端口，请在安装向导的“MMH 网络端口”中改用其他端口后重新安装，或先停止占用该端口的程序（Docker 版 MMH、其他套件或任意服务）。"
exit 0
`, 0o755);
}

function writeStartStopStatus() {
  write(path.join(stageDir, "scripts", "start-stop-status"), `#!/bin/sh

PACKAGE="mmh"
APP_DIR="\${SYNOPKG_PKGDEST:-/var/packages/$PACKAGE/target}"
SERVER_DIR="$APP_DIR/app/server"
NODE_BIN="$APP_DIR/app/bin/node"
VAR_DIR="\${SYNOPKG_PKGVAR:-/var/packages/$PACKAGE/var}"
LEGACY_VAR_DIR="$APP_DIR/var"
DATA_DIR="$VAR_DIR/data"
ENV_FILE="$VAR_DIR/mmh.env"
SYSTEM_PASSWORD_FILE="$VAR_DIR/mmh-system-password.txt"
SESSION_SECRET_FILE="$VAR_DIR/mmh-session-secret.txt"
PASSWORD_RESET_SECRET_FILE="$VAR_DIR/mmh-password-reset-secret.txt"
PID_FILE="$VAR_DIR/mmh.pid"
LOG_FILE="$VAR_DIR/mmh.log"
DSM_LOG_FILE="\${SYNOPKG_TEMP_LOGFILE:-$VAR_DIR/synopkg-start.log}"
DSM_CONFIG_FILE="$APP_DIR/app/config"
OWN_SERVER_JS="$SERVER_DIR/server.js"

${portIdentityShell}

read_env_value() {
  key="$1"
  [ -f "$ENV_FILE" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "$key="*)
        val="\${line#*=}"
        val="\${val#\\'}"
        val="\${val%\\'}"
        printf '%s' "$val"
        return 0
        ;;
    esac
  done < "$ENV_FILE"
}

generate_system_password() {
  generated=""
  if command -v openssl >/dev/null 2>&1; then
    generated="$(openssl rand -base64 24 2>/dev/null | tr -dc 'A-Za-z0-9' | head -c 16 || true)"
  fi
  if [ -z "$generated" ] && command -v sha256sum >/dev/null 2>&1; then
    generated="$(date +%s%N | sha256sum | tr -dc 'A-Za-z0-9' | head -c 16 || true)"
  fi
  if [ -z "$generated" ]; then
    generated="mmh$(date +%s | tail -c 11)"
  fi
  printf '%s' "$generated"
}

generate_session_secret() {
  generated=""
  if command -v openssl >/dev/null 2>&1; then
    generated="$(openssl rand -base64 48 2>/dev/null | tr -d '[:space:]' || true)"
  fi
  if [ -z "$generated" ] && [ -x "$NODE_BIN" ]; then
    generated="$("$NODE_BIN" -e 'process.stdout.write(require("node:crypto").randomBytes(48).toString("base64url"))' 2>/dev/null || true)"
  fi
  if [ -n "$generated" ] && [ "\${#generated}" -ge 32 ]; then
    printf '%s' "$generated"
    return 0
  fi
  return 1
}

append_log() {
  mkdir -p "$VAR_DIR" 2>/dev/null || true
  message="$(date '+%Y-%m-%d %H:%M:%S') $*"
  echo "$message" >>"$LOG_FILE" 2>/dev/null || true
}

write_dsm_error() {
  mkdir -p "$VAR_DIR" 2>/dev/null || true
  printf '%s\n' "MMH failed to start: $*" >>"$DSM_LOG_FILE" 2>/dev/null || true
}

fail_start() {
  append_log "ERROR: $*"
  write_dsm_error "$*"
  echo "MMH failed to start. See $LOG_FILE for details." >&2
  exit 1
}

port_listener_inodes() {
  port="$1"
  port_hex="$(printf '%04X' "$port" 2>/dev/null)" || return 1
  for table in /proc/net/tcp /proc/net/tcp6; do
    [ -r "$table" ] || continue
    awk -v wanted="$port_hex" '
      NR > 1 {
        split($2, endpoint, ":")
        if (toupper(endpoint[2]) == wanted && $4 == "0A") print $10
      }
    ' "$table"
  done
}

port_is_listening() {
  port_listener_inodes "$1" | grep . >/dev/null 2>&1 && return 0
  if command -v netstat >/dev/null 2>&1; then
    port="$1"
    netstat -ltn 2>/dev/null | awk -v port="$port" '
      {
        address=$4
        sub(/^.*:/, "", address)
        if (address == port) found=1
      }
      END { exit(found ? 0 : 1) }
    '
    return $?
  fi
  return 1
}

process_owns_port() {
  pid="$1"
  port="$2"
  for inode in $(port_listener_inodes "$port"); do
    for fd in /proc/$pid/fd/*; do
      link="$(readlink "$fd" 2>/dev/null || true)"
      [ "$link" = "socket:[$inode]" ] && return 0
    done
  done
  return 1
}

persist_port() {
  port="$1"
  temp_file="$ENV_FILE.tmp.$$"
  if sed "s/^PORT=.*/PORT=$port/" "$ENV_FILE" > "$temp_file" 2>/dev/null; then
    mv "$temp_file" "$ENV_FILE" || return 1
    chmod 600 "$ENV_FILE" 2>/dev/null || true
    return 0
  fi
  rm -f "$temp_file" 2>/dev/null || true
  return 1
}

update_dsm_app_config() {
  port="$1"
  app_dir="\${SYNOPKG_PKGDEST:-/var/packages/$PACKAGE/target}"
  for dsm_ui_dir in ui app app/ui; do
    dsm_config_file="$app_dir/$dsm_ui_dir/config"
    [ -f "$dsm_config_file" ] || continue
    temp_file="$dsm_config_file.tmp.$$"
    if sed "s/\\"port\\": \\"[0-9][0-9]*\\"/\\"port\\": \\"$port\\"/" "$dsm_config_file" > "$temp_file" 2>/dev/null; then
      mv "$temp_file" "$dsm_config_file" 2>/dev/null || rm -f "$temp_file" 2>/dev/null || true
    else
      rm -f "$temp_file" 2>/dev/null || true
    fi
  done
}

update_dsm_wizard_defaults() {
  port="$1"
  wizard_dir="/var/packages/$PACKAGE/WIZARD_UIFILES"
  # DSM owns this directory as root, while start-stop-status and config run as
  # the package user, so the rewrite failed with "Permission denied" on every
  # start (seen in /var/log/packages/mmh.log on 2026-09-29/30). postinst runs as
  # root and performs the real sync; skip silently when it is not writable.
  [ -w "$wizard_dir" ] || return 0
  for wizard_file in "$wizard_dir/install_uifile" "$wizard_dir/upgrade_uifile"; do
    [ -f "$wizard_file" ] || continue
    temp_file="$wizard_file.tmp.$$"
    if sed '/"key": "wizard_port"/,/"defaultValue":/ s/"defaultValue": "[0-9][0-9]*"/"defaultValue": "'"$port"'"/' "$wizard_file" > "$temp_file" 2>/dev/null; then
      mv "$temp_file" "$wizard_file" 2>/dev/null || rm -f "$temp_file" 2>/dev/null || true
    else
      rm -f "$temp_file" 2>/dev/null || true
    fi
  done
}

is_own_mmh_pid() {
  [ -f "$PID_FILE" ] || return 1
  pid="$(cat "$PID_FILE" 2>/dev/null)"
  case "$pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  kill -0 "$pid" >/dev/null 2>&1 || return 1
  process_is_containerized "$pid" && return 1
  if ! process_belongs_to_package "$pid" && ! process_runs_our_server "$pid"; then
    return 1
  fi
  return 0
}

is_own_mmh_process() {
  is_own_mmh_pid || return 1
  port_is_listening "$1"
}

ensure_port_available() {
  requested_port="$1"
  if ! port_is_listening "$requested_port"; then
    return 0
  fi
  env_port="$(read_env_value PORT 2>/dev/null || true)"
  if [ "$env_port" = "$requested_port" ] && is_own_mmh_process "$requested_port"; then
    return 0
  fi
  message="Port $requested_port is occupied by another service. Choose a different MMH port in the installer or package settings."
  append_log "ERROR: $message"
  echo "MMH cannot use port $requested_port: it is occupied by another service. Choose a different port in the MMH port setting and retry." >&2
  return 1
}

ensure_runtime_settings() {
  mkdir -p "$DATA_DIR"
  env_port="$(read_env_value PORT 2>/dev/null || true)"
  export PORT="\${PORT:-\${env_port:-7777}}"

  env_password="$(read_env_value MMH_SYSTEM_PASSWORD 2>/dev/null || true)"
  system_password="\${MMH_SYSTEM_PASSWORD:-$env_password}"
  if [ -z "$system_password" ] && [ -f "$SYSTEM_PASSWORD_FILE" ]; then
    system_password="$(tr -d '[:space:]' < "$SYSTEM_PASSWORD_FILE")"
  fi
  if [ -z "$system_password" ]; then
    system_password="$(generate_system_password)"
    append_log "Generated MMH system password at $SYSTEM_PASSWORD_FILE"
  fi
  export MMH_SYSTEM_PASSWORD="$system_password"

  env_session_secret="$(read_env_value MMH_SESSION_SECRET 2>/dev/null || true)"
  session_secret="\${MMH_SESSION_SECRET:-$env_session_secret}"
  if [ -z "$session_secret" ] && [ -f "$SESSION_SECRET_FILE" ]; then
    session_secret="$(tr -d '[:space:]' < "$SESSION_SECRET_FILE")"
  fi
  if [ -z "$session_secret" ] || [ "\${#session_secret}" -lt 32 ]; then
    session_secret="$(generate_session_secret)" || {
      append_log "ERROR: Unable to generate a strong MMH session secret."
      return 1
    }
  fi
  export MMH_SESSION_SECRET="$session_secret"

  # PASSWORD_RESET_SECRET signs email verification codes (registration) and
  # password-reset tokens. Optional: empty merely disables those two features,
  # so a generation failure is non-fatal (unlike the session secret). Persisted
  # to a file so issued codes/tokens keep verifying across restarts.
  env_password_reset_secret="$(read_env_value PASSWORD_RESET_SECRET 2>/dev/null || true)"
  password_reset_secret="\${PASSWORD_RESET_SECRET:-$env_password_reset_secret}"
  case "$password_reset_secret" in
    ""|CHANGE_ME*) password_reset_secret="" ;;
  esac
  if [ -z "$password_reset_secret" ] && [ -f "$PASSWORD_RESET_SECRET_FILE" ]; then
    password_reset_secret="$(tr -d '[:space:]' < "$PASSWORD_RESET_SECRET_FILE")"
  fi
  case "$password_reset_secret" in
    ""|CHANGE_ME*) password_reset_secret="" ;;
  esac
  if [ -z "$password_reset_secret" ]; then
    password_reset_secret="$(generate_session_secret 2>/dev/null || true)"
  fi
  if [ -n "$password_reset_secret" ]; then
    export PASSWORD_RESET_SECRET="$password_reset_secret"
  fi

  env_node_max_old_space="$(read_env_value MMH_NODE_MAX_OLD_SPACE_MB 2>/dev/null || true)"
  node_max_old_space="\${MMH_NODE_MAX_OLD_SPACE_MB:-\${env_node_max_old_space:-auto}}"
  case "$node_max_old_space" in
    ""|*[!0-9]*) node_max_old_space=auto ;;
  esac
  export MMH_NODE_MAX_OLD_SPACE_MB="$node_max_old_space"

  # Email-registration service credentials (mmh-registration). The central
  # mmh-registration service issues the global MMH identity, so MMH login /
  # registration needs both the URL and the shared API token. The URL and token
  # ship with a default (the official floatingice.win service) but remain
  # overridable via MMH_REGISTRATION_API_URL / MMH_REGISTRATION_API_TOKEN, and
  # a user can still disable registration by blanking them in mmh.env.
  env_reg_url="$(read_env_value MMH_REGISTRATION_API_URL 2>/dev/null || true)"
  env_reg_token="$(read_env_value MMH_REGISTRATION_API_TOKEN 2>/dev/null || true)"
  reg_url="\${MMH_REGISTRATION_API_URL:-\${env_reg_url:-https://fnapp.floatingice.win:10101}}"
  reg_token="\${MMH_REGISTRATION_API_TOKEN:-\${env_reg_token:-3f91f7ff3e2dd134b66f08c69cc4ec43e84bb0b268729f0a1ee846ee23c7919e}}"
  [ -n "$reg_url" ] && export MMH_REGISTRATION_API_URL="$reg_url"
  [ -n "$reg_token" ] && export MMH_REGISTRATION_API_TOKEN="$reg_token"

  cat > "$ENV_FILE" <<EOF
PORT=\${PORT}
TZ=Asia/Shanghai
MMH_SYSTEM_PASSWORD=\${MMH_SYSTEM_PASSWORD}
MMH_SESSION_SECRET=\${MMH_SESSION_SECRET}
MMH_NODE_MAX_OLD_SPACE_MB=\${MMH_NODE_MAX_OLD_SPACE_MB}
MMH_REGISTRATION_API_URL=\${reg_url}
MMH_REGISTRATION_API_TOKEN=\${reg_token}
PASSWORD_RESET_SECRET=\${password_reset_secret}
EOF
  chmod 600 "$ENV_FILE" 2>/dev/null || true
  printf '%s\\n' "$MMH_SYSTEM_PASSWORD" > "$SYSTEM_PASSWORD_FILE"
  chmod 600 "$SYSTEM_PASSWORD_FILE" 2>/dev/null || true
  printf '%s\\n' "$MMH_SESSION_SECRET" > "$SESSION_SECRET_FILE"
  chmod 600 "$SESSION_SECRET_FILE" 2>/dev/null || true
  if [ -n "$password_reset_secret" ]; then
    printf '%s\\n' "$password_reset_secret" > "$PASSWORD_RESET_SECRET_FILE"
    chmod 600 "$PASSWORD_RESET_SECRET_FILE" 2>/dev/null || true
  fi
}

memory_limit_to_mb() {
  value="$(printf '%s' "\${1:-}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
  [ -n "$value" ] && [ "$value" != "max" ] || return 1
  case "$value" in
    *gb|*g)
      number="\${value%gb}"
      number="\${number%g}"
      ;;
    *mb|*m)
      number="\${value%mb}"
      number="\${number%m}"
      ;;
    *kb|*k)
      number="\${value%kb}"
      number="\${number%k}"
      ;;
    *b)
      number="\${value%b}"
      ;;
    *[!0-9]*)
      return 1
      ;;
    *)
      number="$value"
      ;;
  esac
  case "$number" in
    ""|*[!0-9]*) return 1 ;;
  esac
  case "$value" in
    *gb|*g) echo $((number * 1024)) ;;
    *kb|*k) echo $((number / 1024)) ;;
    *b) echo $((number / 1048576)) ;;
    *) echo "$number" ;;
  esac
}

detect_runtime_memory_limit_mb() {
  if runtime_limit="$(memory_limit_to_mb "\${MMH_APP_MEMORY_LIMIT:-}")" && [ "$runtime_limit" -gt 0 ]; then
    echo "$runtime_limit"
    return 0
  fi

  host_total_mb=""
  if [ -r /proc/meminfo ]; then
    host_total_kb="$(awk '/^MemTotal:/ { print $2; exit }' /proc/meminfo 2>/dev/null || true)"
    case "$host_total_kb" in
      ""|*[!0-9]*) ;;
      *) host_total_mb=$((host_total_kb / 1024)) ;;
    esac
  fi

  for limit_file in /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory/memory.limit_in_bytes; do
    if [ -r "$limit_file" ]; then
      raw_limit="$(cat "$limit_file" 2>/dev/null | tr -d '[:space:]')"
      case "$raw_limit" in
        ""|max|*[!0-9]*) ;;
        *)
          cgroup_limit_mb=$((raw_limit / 1048576))
          if [ "$cgroup_limit_mb" -gt 0 ] && { [ -z "$host_total_mb" ] || [ "$cgroup_limit_mb" -le $((host_total_mb * 2)) ]; }; then
            echo "$cgroup_limit_mb"
            return 0
          fi
          ;;
      esac
    fi
  done

  if [ -n "$host_total_mb" ] && [ "$host_total_mb" -gt 0 ]; then
    echo "$host_total_mb"
    return 0
  fi

  echo 0
}

recommended_node_old_space_mb() {
  runtime_limit_mb="$(detect_runtime_memory_limit_mb)"
  case "$runtime_limit_mb" in
    ""|*[!0-9]*|0) echo 768 ;;
    *)
      if [ "$runtime_limit_mb" -lt 1280 ]; then
        echo 384
      elif [ "$runtime_limit_mb" -lt 3072 ]; then
        echo 768
      elif [ "$runtime_limit_mb" -lt 6144 ]; then
        echo 1024
      else
        echo 1536
      fi
      ;;
  esac
}

apply_node_memory_limit() {
  MMH_NODE_MAX_OLD_SPACE_MB="\${MMH_NODE_MAX_OLD_SPACE_MB:-auto}"
  case "$MMH_NODE_MAX_OLD_SPACE_MB" in
    auto|AUTO|Auto)
      MMH_NODE_MAX_OLD_SPACE_MB="$(recommended_node_old_space_mb)"
      ;;
    ""|0|*[!0-9]*)
      MMH_NODE_MAX_OLD_SPACE_MB="$(recommended_node_old_space_mb)"
      ;;
  esac
  case "\${NODE_OPTIONS:-}" in
    *--max-old-space-size*|*--max_old_space_size*)
      ;;
    *)
      NODE_OPTIONS="\${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=$MMH_NODE_MAX_OLD_SPACE_MB"
      ;;
  esac
  export MMH_NODE_MAX_OLD_SPACE_MB NODE_OPTIONS
}

migrate_legacy_var_dir() {
  if [ "$LEGACY_VAR_DIR" != "$VAR_DIR" ] && [ -d "$LEGACY_VAR_DIR" ] && [ ! -f "$DATA_DIR/mmh.db" ]; then
    mkdir -p "$VAR_DIR" "$DATA_DIR"
    cp -a "$LEGACY_VAR_DIR/." "$VAR_DIR/" 2>/dev/null || true
  fi
}

start_app() {
  mkdir -p "$VAR_DIR" "$DATA_DIR"
  migrate_legacy_var_dir
  ensure_runtime_settings
  apply_node_memory_limit
  append_log "MMH start requested: app=$APP_DIR var=$VAR_DIR data=$DATA_DIR user=$(id -u 2>/dev/null || echo unknown):$(id -g 2>/dev/null || echo unknown) port=\${PORT:-7777}"
  if [ ! -x "$NODE_BIN" ]; then
    fail_start "Bundled Linux Node runtime is missing or not executable: $NODE_BIN"
  fi
  if [ ! -f "$SERVER_DIR/server.js" ]; then
    fail_start "Next standalone server is missing: $SERVER_DIR/server.js"
  fi
  export NODE_ENV=production
  export HOSTNAME=0.0.0.0
  export MMH_DEPLOY_TARGET=synology
  export MMH_APP_VERSION="${version}"
  export MMH_DATA_DIR="$DATA_DIR"
  export DATABASE_URL="file:$DATA_DIR/mmh.db"
  export PRISMA_SCHEMA_PATH="$SERVER_DIR/prisma/schema.native.prisma"
  append_log "Testing bundled Node runtime: $NODE_BIN"
  if ! "$NODE_BIN" -v >>"$LOG_FILE" 2>&1; then
    append_log "Bundled Node runtime failed to execute; ldd output follows when available."
    if command -v ldd >/dev/null 2>&1; then
      ldd "$NODE_BIN" >>"$LOG_FILE" 2>&1 || true
    fi
    fail_start "Bundled Node runtime failed to execute."
  fi
  append_log "Initializing SQLite database at $DATA_DIR/mmh.db"
  if ! (cd "$SERVER_DIR" && "$NODE_BIN" "$SERVER_DIR/scripts/init-sqlite.cjs") >>"$LOG_FILE" 2>&1; then
    fail_start "SQLite initialization failed."
  fi
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" >/dev/null 2>&1; then
    if is_own_mmh_process "$PORT"; then
      append_log "MMH already running with pid $(cat "$PID_FILE")"
      exit 0
    fi
  fi
  rm -f "$PID_FILE"
  if ! ensure_port_available "$PORT"; then
    fail_start "Port $PORT is occupied by another service. Choose a different MMH port in package settings."
  fi
  update_dsm_app_config "$PORT"
  update_dsm_wizard_defaults "$PORT"
  append_log "Launching Next standalone server."
  if command -v setsid >/dev/null 2>&1; then
    nohup setsid "$NODE_BIN" "$SERVER_DIR/server.js" </dev/null >>"$LOG_FILE" 2>&1 &
  else
    nohup "$NODE_BIN" "$SERVER_DIR/server.js" </dev/null >>"$LOG_FILE" 2>&1 &
  fi
  echo "$!" > "$PID_FILE"
  launched_pid="$!"
  wait_seconds=0
  while [ "$wait_seconds" -lt 30 ]; do
    if ! kill -0 "$launched_pid" >/dev/null 2>&1; then
      rm -f "$PID_FILE"
      fail_start "MMH server process exited during startup."
    fi
    if port_is_listening "$PORT" && process_owns_port "$launched_pid" "$PORT"; then
      append_log "MMH started with pid $launched_pid and port $PORT is listening."
      return 0
    fi
    sleep 1
    wait_seconds=$((wait_seconds + 1))
  done
  append_log "ERROR: MMH pid $launched_pid remained alive but did not own port $PORT after \${wait_seconds}s."
  kill "$launched_pid" >/dev/null 2>&1 || true
  rm -f "$PID_FILE"
  fail_start "MMH server did not become ready on port $PORT."
}

stop_app() {
  if is_own_mmh_pid; then
    pid="$(cat "$PID_FILE")"
    kill "$pid" >/dev/null 2>&1 || true
    wait_seconds=0
    while kill -0 "$pid" >/dev/null 2>&1 && [ "$wait_seconds" -lt 10 ]; do
      sleep 1
      wait_seconds=$((wait_seconds + 1))
    done
    kill -9 "$pid" >/dev/null 2>&1 || true
  fi
  rm -f "$PID_FILE"
}

status_app() {
  port="$(read_env_value PORT 2>/dev/null || echo 7777)"
  if is_own_mmh_process "$port"; then
    exit 0
  fi
  exit 3
}

case "\${1:-status}" in
  start)
    start_app
    ;;
  stop)
    stop_app
    ;;
  status)
    status_app
    ;;
  log)
    tail -n "\${2:-100}" "$LOG_FILE"
    ;;
  *)
    exit 1
    ;;
esac
`, 0o755);
}

function writeLifecycleScripts() {
  write(path.join(stageDir, "scripts", "postinst"), `#!/bin/sh

PACKAGE="mmh"
APP_DIR="\${SYNOPKG_PKGDEST:-/var/packages/$PACKAGE/target}"
SERVER_DIR="$APP_DIR/app/server"
VAR_DIR="\${SYNOPKG_PKGVAR:-/var/packages/$PACKAGE/var}"
ENV_FILE="$VAR_DIR/mmh.env"
PID_FILE="$VAR_DIR/mmh.pid"
OWN_SERVER_JS="$SERVER_DIR/server.js"

${portIdentityShell}

port_is_listening() {
  port_listener_inodes "$1" | grep . >/dev/null 2>&1 && return 0
  port="$1"
  port_hex="$(printf '%04X' "$port" 2>/dev/null)" || return 1
  for table in /proc/net/tcp /proc/net/tcp6; do
    [ -r "$table" ] || continue
    if awk -v wanted="$port_hex" '
      NR > 1 {
        split($2, endpoint, ":")
        if (toupper(endpoint[2]) == wanted && $4 == "0A") found=1
      }
      END { exit(found ? 0 : 1) }
    ' "$table"; then
      return 0
    fi
  done
  if command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | awk -v port="$port" '
      {
        address=$4
        sub(/^.*:/, "", address)
        if (address == port) found=1
      }
      END { exit(found ? 0 : 1) }
    '
    return $?
  fi
  return 1
}

port_listener_inodes() {
  port="$1"
  port_hex="$(printf '%04X' "$port" 2>/dev/null)" || return 1
  for table in /proc/net/tcp /proc/net/tcp6; do
    [ -r "$table" ] || continue
    awk -v wanted="$port_hex" '
      NR > 1 {
        split($2, endpoint, ":")
        if (toupper(endpoint[2]) == wanted && $4 == "0A") print $10
      }
    ' "$table"
  done
}

process_owns_port() {
  pid="$1"
  port="$2"
  for inode in $(port_listener_inodes "$port"); do
    for fd in /proc/$pid/fd/*; do
      link="$(readlink "$fd" 2>/dev/null || true)"
      [ "$link" = "socket:[$inode]" ] && return 0
    done
  done
  return 1
}

is_own_mmh_pid() {
  [ -f "$PID_FILE" ] || return 1
  pid="$(cat "$PID_FILE" 2>/dev/null)"
  case "$pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  kill -0 "$pid" >/dev/null 2>&1 || return 1
  process_is_containerized "$pid" && return 1
  if ! process_belongs_to_package "$pid" && ! process_runs_our_server "$pid"; then
    return 1
  fi
  return 0
}

is_own_mmh_process() {
  is_own_mmh_pid || return 1
  port_is_listening "$1"
}

ensure_port_available() {
  requested_port="$1"
  if ! port_is_listening "$requested_port"; then
    return 0
  fi
  if [ "$(cat "$ENV_FILE" 2>/dev/null | sed -n 's/^PORT=//p' | head -n 1)" = "$requested_port" ] && is_own_mmh_process "$requested_port"; then
    return 0
  fi
  return 1
}

probe_free_port() {
  candidate="$1"
  tries=0
  while [ "$tries" -lt 200 ]; do
    if ! port_is_listening "$candidate"; then
      printf '%s' "$candidate"
      return 0
    fi
    candidate=$((candidate + 1))
    tries=$((tries + 1))
  done
  return 1
}

update_dsm_app_config() {
  port="$1"
  app_dir="\${SYNOPKG_PKGDEST:-/var/packages/$PACKAGE/target}"
  for dsm_ui_dir in ui app app/ui; do
    dsm_config_file="$app_dir/$dsm_ui_dir/config"
    [ -f "$dsm_config_file" ] || continue
    temp_file="$dsm_config_file.tmp.$$"
    if sed "s/\\"port\\": \\"[0-9][0-9]*\\"/\\"port\\": \\"$port\\"/" "$dsm_config_file" > "$temp_file" 2>/dev/null; then
      mv "$temp_file" "$dsm_config_file" 2>/dev/null || rm -f "$temp_file" 2>/dev/null || true
    else
      rm -f "$temp_file" 2>/dev/null || true
    fi
  done
}

# postinst is the only lifecycle script that runs as root, so it is the only one
# that can rewrite DSM's root-owned WIZARD_UIFILES. It called this function
# without ever defining it, so every install logged
# "update_dsm_wizard_defaults: command not found" and the wizard kept a stale
# port default (seen in /var/log/packages/mmh.log on 2026-09-28/29/30).
update_dsm_wizard_defaults() {
  port="$1"
  wizard_dir="/var/packages/$PACKAGE/WIZARD_UIFILES"
  [ -w "$wizard_dir" ] || return 0
  for wizard_file in "$wizard_dir/install_uifile" "$wizard_dir/upgrade_uifile"; do
    [ -f "$wizard_file" ] || continue
    temp_file="$wizard_file.tmp.$$"
    if sed '/"key": "wizard_port"/,/"defaultValue":/ s/"defaultValue": "[0-9][0-9]*"/"defaultValue": "'"$port"'"/' "$wizard_file" > "$temp_file" 2>/dev/null; then
      mv "$temp_file" "$wizard_file" 2>/dev/null || rm -f "$temp_file" 2>/dev/null || true
    else
      rm -f "$temp_file" 2>/dev/null || true
    fi
  done
}

restore_upgrade_data() {
  backup_dir="$SYNOPKG_TEMP_UPGRADE_FOLDER/mmh-preserved"
  if [ -z "\${SYNOPKG_TEMP_UPGRADE_FOLDER:-}" ] || [ ! -d "$backup_dir" ]; then
    return 0
  fi
  mkdir -p "$VAR_DIR/data" || return 1
  for file in "$backup_dir/data/"*; do
    [ -f "$file" ] || continue
    cp -p "$file" "$VAR_DIR/data/" || return 1
  done
  port="$(cat "$backup_dir/port" 2>/dev/null | tr -d '[:space:]')"
  case "$port" in
    ''|*[!0-9]*) port="" ;;
  esac
  if [ -n "$port" ] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ]; then
    printf 'PORT=%s\\n' "$port" > "$VAR_DIR/mmh.env" || return 1
    chown mmh:mmh "$VAR_DIR/mmh.env" 2>/dev/null || true
    chmod 600 "$VAR_DIR/mmh.env" 2>/dev/null || true
  fi
  return 0
}

mkdir -p "$VAR_DIR" || exit 1
restore_upgrade_data || exit 1
previous_port=""
if [ -f "$ENV_FILE" ]; then
  previous_port="$(sed -n 's/^PORT=//p' "$ENV_FILE" | head -n 1)"
fi
case "$previous_port" in
  ''|*[!0-9]*) previous_port="" ;;
esac
# The wizard pre-fills the port an upgrade would otherwise keep, so a submitted
# value only counts as a user selection when it DIFFERS from the port the
# wizard itself proposed (recorded in mmh-wizard-port by the wizard script).
# Without that record - a wizard that fell back to the static JSON default, or
# no wizard at all - an upgrade keeps the port already persisted; that guard is
# what stops a 7777 default from silently moving a live install. Mirrors
# preinst; see docs/product-todos.md ("精确版 A" = option C).
wizard_port_value="$(printf '%s' "\${wizard_port:-}" | tr -d '[:space:]')"
case "$wizard_port_value" in
  ''|*[!0-9]*) wizard_port_value="" ;;
esac
wizard_recorded_port="$(cat "$VAR_DIR/mmh-wizard-port" 2>/dev/null | tr -d '[:space:]')"
case "$wizard_recorded_port" in
  ''|*[!0-9]*) wizard_recorded_port="" ;;
esac
rm -f "$VAR_DIR/mmh-wizard-port" 2>/dev/null || true

port=""
port_source=""
if [ -n "$wizard_port_value" ] && [ -n "$wizard_recorded_port" ] && [ "$wizard_port_value" != "$wizard_recorded_port" ]; then
  port="$wizard_port_value"
  port_source="installer selection"
fi
if [ -z "$port" ] && [ -n "$previous_port" ] && [ "$previous_port" -ge 1 ] && [ "$previous_port" -le 65535 ]; then
  port="$previous_port"
  port_source="existing installation"
fi
if [ -z "$port" ]; then
  port="\${wizard_port_value:-7777}"
  case "$port" in
    ''|*[!0-9]*) echo "MMH service port must be a number between 1 and 65535." >&2; exit 1 ;;
  esac
  if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
    echo "MMH service port must be between 1 and 65535." >&2
    exit 1
  fi
  port_source="installer selection"
fi
echo "MMH requested service port: $port ($port_source)." >&2
if ! ensure_port_available "$port"; then
  requested_port="$port"
  if advanced_port="$(probe_free_port $((port + 1)))"; then
    port="$advanced_port"
    port_source="auto-advanced from $requested_port (occupied)"
    echo "MMH port $requested_port is occupied by another service; switching to $port." >&2
  else
    echo "MMH could not find a free port at or after $requested_port. Choose a different port in the MMH port setting and retry." >&2
    exit 1
  fi
fi
if is_own_mmh_process "$port"; then
  old_pid="$(cat "$PID_FILE" 2>/dev/null)"
  kill "$old_pid" >/dev/null 2>&1 || true
  sleep 1
  kill -0 "$old_pid" >/dev/null 2>&1 && kill -9 "$old_pid" >/dev/null 2>&1 || true
fi
for entry in "$VAR_DIR"/* "$VAR_DIR"/.[!.]* "$VAR_DIR"/..?*; do
  [ -e "$entry" ] || [ -L "$entry" ] || continue
  if [ "$entry" = "$VAR_DIR/data" ] && [ -d "$entry" ]; then
    for data_entry in "$entry"/* "$entry"/.[!.]* "$entry"/..?*; do
      [ -e "$data_entry" ] || [ -L "$data_entry" ] || continue
      case "$data_entry" in
        "$entry/mmh.db"|"$entry/mmh.db-wal"|"$entry/mmh.db-shm") continue ;;
      esac
      rm -rf "$data_entry" || exit 1
    done
    continue
  fi
  rm -rf "$entry" || exit 1
done
mkdir -p "$VAR_DIR/data" || exit 1
printf 'PORT=%s\\n' "$port" > "$ENV_FILE" || exit 1
chown mmh:mmh "$ENV_FILE" 2>/dev/null || true
chmod 600 "$ENV_FILE" 2>/dev/null || true
update_dsm_app_config "$port"
update_dsm_wizard_defaults "$port"
printf '%s\\n' "$(date '+%Y-%m-%d %H:%M:%S') Installation completed using port $port ($port_source)." >>"$VAR_DIR/mmh.log" 2>/dev/null || true
echo "MMH service port: $port ($port_source)."
exit 0
`, 0o755);
  write(path.join(stageDir, "scripts", "config"), `#!/bin/sh

PACKAGE="mmh"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
APP_DIR="\${SYNOPKG_PKGDEST:-/var/packages/$PACKAGE/target}"
SERVER_DIR="$APP_DIR/app/server"
VAR_DIR="\${SYNOPKG_PKGVAR:-/var/packages/$PACKAGE/var}"
ENV_FILE="$VAR_DIR/mmh.env"
LOG_FILE="$VAR_DIR/mmh.log"
PID_FILE="$VAR_DIR/mmh.pid"
OWN_SERVER_JS="$SERVER_DIR/server.js"

${portIdentityShell}

port_listener_inodes() {
  port="$1"
  port_hex="$(printf '%04X' "$port" 2>/dev/null)" || return 1
  for table in /proc/net/tcp /proc/net/tcp6; do
    [ -r "$table" ] || continue
    awk -v wanted="$port_hex" '
      NR > 1 {
        split($2, endpoint, ":")
        if (toupper(endpoint[2]) == wanted && $4 == "0A") print $10
      }
    ' "$table"
  done
}

port_is_listening() {
  port_listener_inodes "$1" | grep . >/dev/null 2>&1 && return 0
  port="$1"
  if command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | awk -v port="$port" '
      {
        address=$4
        sub(/^.*:/, "", address)
        if (address == port) found=1
      }
      END { exit(found ? 0 : 1) }
    '
    return $?
  fi
  return 1
}

process_owns_port() {
  pid="$1"
  port="$2"
  for inode in $(port_listener_inodes "$port"); do
    for fd in /proc/$pid/fd/*; do
      link="$(readlink "$fd" 2>/dev/null || true)"
      [ "$link" = "socket:[$inode]" ] && return 0
    done
  done
  return 1
}

is_own_mmh_pid() {
  [ -f "$PID_FILE" ] || return 1
  pid="$(cat "$PID_FILE" 2>/dev/null)"
  case "$pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  kill -0 "$pid" >/dev/null 2>&1 || return 1
  process_is_containerized "$pid" && return 1
  if ! process_belongs_to_package "$pid" && ! process_runs_our_server "$pid"; then
    return 1
  fi
  return 0
}

is_own_mmh_process() {
  is_own_mmh_pid || return 1
  port_is_listening "$1"
}

update_dsm_app_config() {
  port="$1"
  app_dir="\${SYNOPKG_PKGDEST:-/var/packages/$PACKAGE/target}"
  for dsm_ui_dir in ui app app/ui; do
    dsm_config_file="$app_dir/$dsm_ui_dir/config"
    [ -f "$dsm_config_file" ] || continue
    temp_file="$dsm_config_file.tmp.$$"
    if sed "s/\\"port\\": \\"[0-9][0-9]*\\"/\\"port\\": \\"$port\\"/" "$dsm_config_file" > "$temp_file" 2>/dev/null; then
      mv "$temp_file" "$dsm_config_file" 2>/dev/null || rm -f "$temp_file" 2>/dev/null || true
    else
      rm -f "$temp_file" 2>/dev/null || true
    fi
  done
}

update_dsm_wizard_defaults() {
  port="$1"
  wizard_dir="/var/packages/$PACKAGE/WIZARD_UIFILES"
  # DSM owns this directory as root, while start-stop-status and config run as
  # the package user, so the rewrite failed with "Permission denied" on every
  # start (seen in /var/log/packages/mmh.log on 2026-09-29/30). postinst runs as
  # root and performs the real sync; skip silently when it is not writable.
  [ -w "$wizard_dir" ] || return 0
  for wizard_file in "$wizard_dir/install_uifile" "$wizard_dir/upgrade_uifile"; do
    [ -f "$wizard_file" ] || continue
    temp_file="$wizard_file.tmp.$$"
    if sed '/"key": "wizard_port"/,/"defaultValue":/ s/"defaultValue": "[0-9][0-9]*"/"defaultValue": "'"$port"'"/' "$wizard_file" > "$temp_file" 2>/dev/null; then
      mv "$temp_file" "$wizard_file" 2>/dev/null || rm -f "$temp_file" 2>/dev/null || true
    else
      rm -f "$temp_file" 2>/dev/null || true
    fi
  done
}

ensure_port_available() {
  requested_port="$1"
  if ! port_is_listening "$requested_port"; then
    return 0
  fi
  env_port="$(sed -n 's/^PORT=//p' "$ENV_FILE" 2>/dev/null | head -n 1)"
  if [ "$env_port" = "$requested_port" ] && is_own_mmh_process "$requested_port"; then
    return 0
  fi
  echo "MMH cannot use port $requested_port: it is occupied by another service. Choose a different port in the MMH port setting and retry." >&2
  return 1
}

new_port="$(printf '%s' "\${wizard_port:-}" | tr -d '[:space:]')"
case "$new_port" in
  ''|*[!0-9]*) echo "MMH service port must be a number between 1 and 65535." >&2; exit 1 ;;
esac
if [ "$new_port" -lt 1 ] || [ "$new_port" -gt 65535 ]; then
  echo "MMH service port must be between 1 and 65535." >&2
  exit 1
fi

ensure_port_available "$new_port" || {
  echo "MMH cannot change to port $new_port because another service is using it. Choose a different port and retry." >&2
  exit 1
}
"$SCRIPT_DIR/start-stop-status" stop >/dev/null 2>&1 || true
mkdir -p "$VAR_DIR" || exit 1
printf 'PORT=%s\\n' "$new_port" > "$ENV_FILE" || exit 1
chown mmh:mmh "$ENV_FILE" 2>/dev/null || true
chmod 600 "$ENV_FILE" 2>/dev/null || true
printf '%s\\n' "$(date '+%Y-%m-%d %H:%M:%S') Service port changed to $new_port." >> "$LOG_FILE" 2>/dev/null || true
update_dsm_app_config "$new_port"
update_dsm_wizard_defaults "$new_port"
"$SCRIPT_DIR/start-stop-status" start
echo "MMH service port: $new_port."
exit 0
`, 0o755);
  write(path.join(stageDir, "scripts", "preuninst"), `#!/bin/sh

PACKAGE="mmh"
VAR_DIR="\${SYNOPKG_PKGVAR:-/var/packages/$PACKAGE/var}"
# DSM runs preuninst on BOTH uninstall and upgrade, and only the Package Center
# uninstall dialog exports wizard_delete_data. A CLI uninstall
# (synopkg uninstall mmh) never renders the wizard, so the variable stays unset
# and the data is retained - which is how a "fresh" reinstall can come back with
# an old ledger. Keep the value we actually received in the log line, so
# /var/log/packages/mmh.log tells "no wizard ran" apart from "user chose keep":
#   retained (wizard_delete_data=<unset>)  -> CLI/scripted uninstall, never asked
#   retained (wizard_delete_data=false)    -> wizard shown, user picked keep
#   deleted  (wizard_delete_data=true)     -> wizard shown, user picked delete
delete_flag="\${wizard_delete_data:-<unset>}"
if [ "$delete_flag" = "true" ]; then
  if [ -d "$VAR_DIR" ]; then
    case "$VAR_DIR" in
      /|"") echo "Refusing to delete an invalid MMH data path." >&2; exit 1 ;;
    esac
    for entry in "$VAR_DIR"/* "$VAR_DIR"/.[!.]* "$VAR_DIR"/..?*; do
      [ -e "$entry" ] || [ -L "$entry" ] || continue
      rm -rf "$entry" || exit 1
    done
  fi
  echo "MMH database and settings deleted (wizard_delete_data=$delete_flag)."
else
  echo "MMH database and settings retained (wizard_delete_data=$delete_flag)."
fi
exit 0
`, 0o755);
  write(path.join(stageDir, "scripts", "preupgrade"), `#!/bin/sh

PACKAGE="mmh"
VAR_DIR="\${SYNOPKG_PKGVAR:-/var/packages/$PACKAGE/var}"
if [ -n "\${SYNOPKG_TEMP_UPGRADE_FOLDER:-}" ] && [ -d "$VAR_DIR" ]; then
  backup_dir="$SYNOPKG_TEMP_UPGRADE_FOLDER/mmh-preserved"
  mkdir -p "$backup_dir/data" || exit 1
  for file in "$VAR_DIR/data/mmh.db" "$VAR_DIR/data/mmh.db-wal" "$VAR_DIR/data/mmh.db-shm"; do
    [ -f "$file" ] && cp -p "$file" "$backup_dir/data/" || true
  done
  if [ -f "$VAR_DIR/mmh.env" ]; then
    sed -n 's/^PORT=//p' "$VAR_DIR/mmh.env" | head -n 1 > "$backup_dir/port"
  fi
fi
exit 0
`, 0o755);
  write(path.join(stageDir, "scripts", "postupgrade"), `#!/bin/sh

PACKAGE="mmh"
APP_DIR="\${SYNOPKG_PKGDEST:-/var/packages/$PACKAGE/target}"
VAR_DIR="\${SYNOPKG_PKGVAR:-/var/packages/$PACKAGE/var}"
DSM_CONFIG_DIRS="$APP_DIR/ui $APP_DIR/app $APP_DIR/app/ui"
backup_dir="$SYNOPKG_TEMP_UPGRADE_FOLDER/mmh-preserved"
update_dsm_app_config() {
  port="$1"
  for dsm_config_file in $DSM_CONFIG_DIRS; do
    [ -f "$dsm_config_file" ] || continue
    temp_file="$dsm_config_file.tmp.$$"
    if sed "s/\\"port\\": \\"[0-9][0-9]*\\"/\\"port\\": \\"$port\\"/" "$dsm_config_file" > "$temp_file" 2>/dev/null; then
      mv "$temp_file" "$dsm_config_file" 2>/dev/null || rm -f "$temp_file" 2>/dev/null || true
    else
      rm -f "$temp_file" 2>/dev/null || true
    fi
  done
}
update_dsm_wizard_defaults() {
  port="$1"
  wizard_dir="/var/packages/$PACKAGE/WIZARD_UIFILES"
  # DSM owns this directory as root, while start-stop-status and config run as
  # the package user, so the rewrite failed with "Permission denied" on every
  # start (seen in /var/log/packages/mmh.log on 2026-09-29/30). postinst runs as
  # root and performs the real sync; skip silently when it is not writable.
  [ -w "$wizard_dir" ] || return 0
  for wizard_file in "$wizard_dir/install_uifile" "$wizard_dir/upgrade_uifile"; do
    [ -f "$wizard_file" ] || continue
    temp_file="$wizard_file.tmp.$$"
    if sed '/"key": "wizard_port"/,/"defaultValue":/ s/"defaultValue": "[0-9][0-9]*"/"defaultValue": "'"$port"'"/' "$wizard_file" > "$temp_file" 2>/dev/null; then
      mv "$temp_file" "$wizard_file" 2>/dev/null || rm -f "$temp_file" 2>/dev/null || true
    else
      rm -f "$temp_file" 2>/dev/null || true
    fi
  done
}
if [ -d "$backup_dir" ]; then
  mkdir -p "$VAR_DIR" || exit 1
  for entry in "$VAR_DIR"/* "$VAR_DIR"/.[!.]* "$VAR_DIR"/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    rm -rf "$entry" || exit 1
  done
  mkdir -p "$VAR_DIR/data" || exit 1
  for file in "$backup_dir/data/"*; do
    [ -f "$file" ] && cp -p "$file" "$VAR_DIR/data/" || true
  done
  port="$(cat "$backup_dir/port" 2>/dev/null | tr -d '[:space:]')"
  case "$port" in
    ''|*[!0-9]*) port="" ;;
  esac
  if [ -n "$port" ] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ]; then
    printf 'PORT=%s\\n' "$port" > "$VAR_DIR/mmh.env" || exit 1
    chown mmh:mmh "$VAR_DIR/mmh.env" 2>/dev/null || true
    chmod 600 "$VAR_DIR/mmh.env" 2>/dev/null || true
    update_dsm_app_config "$port"
    update_dsm_wizard_defaults "$port"
  fi
fi
exit 0
`, 0o755);
}

function writePrivilege() {
  write(path.join(stageDir, "conf", "privilege"), JSON.stringify({
    defaults: {
      "run-as": "package",
    },
    username: "mmh",
    groupname: "mmh",
  }, null, 2));
}

// DSM links <PKGDEST>/<dsmuidir> to /usr/syno/synoman/webman/3rdparty/<pkg> and reads
// the desktop-app registration from "<dsmuidir>/config" plus the icons from
// "<dsmuidir>/images/<icon template>". An EMPTY dsmuidir creates no link at all, which
// is why Package Center showed neither the "打开" button nor the MMH icon.
// INFO declares dsmuidir="ui"; the legacy "app" layout is mirrored as well because DSM
// documents no default for the UI folder name.
//
// "app/ui" is the fnOS payload's own app-registration folder. It ships a config that
// declares the app id "mmh.Application" (NOT our dsmappname) and points at
// "icon_{0}.png" files that only exist at 64/256, so it must never win: writing our
// registration over it keeps every candidate path consistent instead of leaving a
// wrong-app-name landmine inside the payload.
function dsmUiDirs() {
  return [dsmUiDir, "app", path.join("app", "ui")];
}

function copyIcons() {
  const icon192 = path.join(root, "public", "branding", "mmh-logo-pageflip-192.png");
  const icon512 = path.join(root, "public", "branding", "mmh-logo-pageflip-512.png");
  copyIcon(icon192, path.join(stageDir, "PACKAGE_ICON.PNG"), 72);
  copyIcon(icon512, path.join(stageDir, "PACKAGE_ICON_256.PNG"), 256);
  for (const dir of dsmUiDirs()) {
    for (const size of dsmIconSizes) {
      copyIcon(icon512, path.join(packageRoot, dir, "images", `mmh-${size}.png`), size);
    }
  }
}

function writeDsmAppConfig() {
  const config = JSON.stringify({
    ".url": {
      [dsmAppName]: {
        title: "MMH",
        desc: "家庭记账与财务管理应用",
        icon: "images/mmh-{0}.png",
        type: "url",
        protocol: "http",
        port: adminPort,
        url: "/",
        allUsers: true,
        grantPrivilege: "all",
        advanceGrantPrivilege: true,
      },
    },
  }, null, 2);
  for (const dir of dsmUiDirs()) {
    write(path.join(packageRoot, dir, "config"), config);
  }
}

// Next copies `.env*` into `.next/standalone` unconditionally (its own step, not
// file tracing) and the SPK/FPK start script exports everything the runtime
// needs (DATABASE_URL, MMH_DATA_DIR, secrets), so the bundled copy is pure
// leakage: it carries DATABASE_URL / ADMIN_PASSWORD / RESEND_API_KEY /
// PASSWORD_RESET_SECRET into the published archive. Drop it here.
function stripBundledEnvFiles(serverRoot) {
  for (const name of [".env", ".env.local", ".env.production", ".env.development", ".env.test"]) {
    const abs = path.join(serverRoot, name);
    if (fs.existsSync(abs)) {
      fs.rmSync(abs, { force: true });
      console.log(`[release-gate] removed bundled ${name} from the package payload`);
    }
  }
}

// Anything below means Next file tracing copied the developer's working copy
// into the payload (see outputFileTracingExcludes in next.config.ts). Shipping
// these leaks whole household backups, uploaded attachments and browser test
// logs, so refuse to build instead of publishing them.
function assertNoDeveloperData(serverRoot) {
  const offenders = [];
  for (const rel of [".codex-logs", path.join("data", "backups"), path.join("data", "attachments")]) {
    if (fs.existsSync(path.join(serverRoot, rel))) offenders.push(rel);
  }
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.name.endsWith(".mmhbackup")) {
        offenders.push(path.relative(serverRoot, abs));
      }
    }
  };
  walk(serverRoot);
  const unique = Array.from(new Set(offenders));
  if (unique.length > 0) {
    throw new Error(
      `Refusing to package developer data: ${unique.join(", ")}. ` +
        "Next file tracing copied these into .next/standalone; delete .next and rebuild. " +
        "Do NOT add outputFileTracingExcludes to next.config.ts - it matches nested paths " +
        "(e.g. next/dist/build/output/**) and breaks the standalone server at boot.",
    );
  }
}

function preparePackageRoot() {
  fs.rmSync(stageDir, { recursive: true, force: true });
  mkdirp(packageRoot);
  if (reusePackageTgz) {
    requirePath(reusePackageTgz, `Synology package payload archive not found: ${reusePackageTgz}`);
    const extract = run("tar", ["-xzf", reusePackageTgz, "-C", packageRoot]);
    if (extract.status !== 0) {
      throw new Error(extract.stderr || extract.stdout || "Unable to extract the reusable Synology package payload.");
    }
  } else {
    // Synology must use a root-path standalone build. The fnOS stage is only a
    // source for the architecture-specific Linux runtime and SQLite helpers;
    // copying its full app would bake fnOS's /app/mmh basePath into this SPK.
    runSynologyAppBuild();
    runFnosStage();
    const fnosStage = path.join(root, "release-artifacts", "fnos", target.fnosStageDirName);
    const synologyStandalone = path.join(root, ".next", "standalone");
    requirePath(path.join(synologyStandalone, "server.js"), "Synology standalone build did not produce .next/standalone/server.js.");
    requirePath(path.join(fnosStage, "app", "bin", "node"), `Provide a Linux ${target.nodeArch} Node runtime tarball before building ${spkAssetName()}.`);
    copyDir(synologyStandalone, path.join(packageRoot, "app", "server"));
    copyDir(path.join(root, ".next", "static"), path.join(packageRoot, "app", "server", ".next", "static"));
    copyDir(path.join(root, "public"), path.join(packageRoot, "app", "server", "public"));
    copyFile(path.join(fnosStage, "app", "bin", "node"), path.join(packageRoot, "app", "bin", "node"));
    const fnosServer = path.join(fnosStage, "app", "server");
    for (const helper of [
      "scripts/init-sqlite.cjs",
      "prisma/native-init.sql",
      "prisma/schema.native.prisma",
    ]) {
      requirePath(path.join(fnosServer, helper), `Synology package staging must contain ${helper}.`);
      copyFile(path.join(fnosServer, helper), path.join(packageRoot, "app", "server", helper));
    }
  }
  // Next standalone tracing pulls in `sharp` plus its `@img/*` libvips binaries
  // (both the glibc and musl builds) only because
  // `next/dist/server/image-optimizer.js` contains a literal `require('sharp')`.
  // Every `next/image` in this app is `unoptimized`, so the image optimizer is
  // never exercised and the runtime never loads sharp. Dropping it saves
  // ~14.5 MB compressed and removes the musl libvips half, which DSM cannot use.
  for (const name of ["sharp", "@img"]) {
    fs.rmSync(path.join(packageRoot, "app", "server", "node_modules", ...name.split("/")), {
      recursive: true,
      force: true,
    });
  }
  write(path.join(packageRoot, "app", "server", ".mmh-version"), `${version}\n`);
  requirePath(path.join(packageRoot, "app", "server", "server.js"), "Synology package payload must contain the standalone server.");
  requirePath(path.join(packageRoot, "app", "bin", "node"), `Synology package payload must contain the Linux ${target.nodeArch} Node runtime.`);
  const stagedNativeInitSql = path.join(packageRoot, "app", "server", "prisma", "native-init.sql");
  if (!fs.existsSync(stagedNativeInitSql)) {
    const fallbackCandidates = [
      path.join(root, "release-artifacts", "fnos", target.fnosStageDirName, "app", "server", "prisma", "native-init.sql"),
      path.join(root, "prisma", "native-init.sql"),
    ];
    const fallbackNativeInitSql = fallbackCandidates.find((candidate) => fs.existsSync(candidate));
    requirePath(fallbackNativeInitSql || fallbackCandidates[0], "Synology package payload must contain prisma/native-init.sql.");
    copyFile(fallbackNativeInitSql, stagedNativeInitSql);
  }
  requirePath(stagedNativeInitSql, "Synology package payload must contain prisma/native-init.sql.");
  stripBundledEnvFiles(path.join(packageRoot, "app", "server"));
  assertNoDeveloperData(path.join(packageRoot, "app", "server"));
  writeInfoFile();
  writeInstallWizard();
  writeUpgradeWizard();
  writeStartStopStatus();
  writePreinstScript();
  writeLifecycleScripts();
  writePrivilege();
  copyIcons();
  writeDsmAppConfig();
  writeUninstallWizard();
  makeReadable(stageDir);
}

function buildSpk() {
  if (process.platform !== "linux" && process.env.SYNOLOGY_ALLOW_CROSS_PLATFORM_REPACK !== "1") {
    throw new Error("Synology SPK release packages must be built on Linux so native Node modules match DSM.");
  }
  if (process.platform === "linux" && process.arch !== target.processArch && process.env.SYNOLOGY_ALLOW_CROSS_ARCH !== "1") {
    throw new Error(`SYNOLOGY_TARGET_ARCH=${target.id} must be built on a Linux ${target.processArch} runner.`);
  }

  const stagedServerDir = path.join(packageRoot, "app", "server");
  const nodeTarballRoot = path.join(stageDir, ".synology-node");
  const node20BinDir = path.join(nodeTarballRoot, `node-v20.20.2-linux-${target.nodeArch}`, "bin");
  const node20Bin = path.join(node20BinDir, "node");
  const node20Npm = path.join(node20BinDir, "npm");
  const node20HeadersRoot = path.join(stageDir, ".synology-node-headers");
  fs.rmSync(nodeTarballRoot, { recursive: true, force: true });
  fs.rmSync(node20HeadersRoot, { recursive: true, force: true });
  mkdirp(nodeTarballRoot);
  mkdirp(node20HeadersRoot);
  const nodeExtract = run("tar", ["-xzf", nodeTarball, "-C", nodeTarballRoot]);
  if (nodeExtract.status !== 0) process.exit(nodeExtract.status || 1);
  requirePath(node20Bin, "Synology packaging requires the bundled Node 20 runtime tarball.");
  requirePath(node20Npm, "Synology packaging requires npm from the bundled Node 20 runtime tarball.");
  const headersTarball = process.env.SYNOLOGY_NODE_HEADERS_TARBALL || "";
  requirePath(headersTarball, "SYNOLOGY_NODE_HEADERS_TARBALL is required for the bundled Node 20 native rebuild.");
  const headersExtract = run("tar", ["-xzf", headersTarball, "-C", node20HeadersRoot]);
  if (headersExtract.status !== 0) process.exit(headersExtract.status || 1);
  const nodeHeadersDir = path.join(node20HeadersRoot, "node-v20.20.2");
  requirePath(path.join(nodeHeadersDir, "include", "node", "node.h"), "Node 20 headers are missing include/node/node.h.");
  const sourceServerDir = root;
  const nativeRebuild = run(node20Bin, [node20Npm, "rebuild", "better-sqlite3", "--build-from-source"], {
    cwd: sourceServerDir,
    stdio: "inherit",
    env: {
      npm_config_nodedir: nodeHeadersDir,
      npm_config_runtime: "node",
      npm_config_build_from_source: "true",
    },
  });
  if (nativeRebuild.status !== 0) process.exit(nativeRebuild.status || 1);
  const sourceNativeModule = path.join(root, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
  const stagedNativeModule = path.join(stagedServerDir, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
  requirePath(sourceNativeModule, "Node 20 native rebuild did not produce better_sqlite3.node in the source tree.");
  copyFile(sourceNativeModule, stagedNativeModule);
  const verifyNative = run(node20Bin, ["-e", "const Database=require('better-sqlite3'); const db=new Database(':memory:'); if (db.prepare('select 1 as ok').get().ok !== 1) process.exit(1); db.close();"], {
    cwd: stagedServerDir,
    stdio: "inherit",
  });
  if (verifyNative.status !== 0) process.exit(verifyNative.status || 1);
  fs.rmSync(nodeTarballRoot, { recursive: true, force: true });
  fs.rmSync(node20HeadersRoot, { recursive: true, force: true });

  const packageTgz = path.join(stageDir, "package.tgz");
  fs.rmSync(packageTgz, { force: true });
  const packageTar = run("tar", [...tarOwnerArgs(), "-czf", packageTgz, "-C", packageRoot, "."]);
  if (packageTar.status !== 0) {
    console.error(packageTar.stderr || packageTar.stdout || "package.tgz packaging failed");
    process.exit(packageTar.status || 1);
  }
  setTarEntryModes(packageTgz, ["app/bin/node"], true);
  writeInfoFile({
    checksum: hashFileMd5(packageTgz),
    extractSizeKb: directorySizeKb(packageRoot),
  });
  makeReadable(stageDir);

  const spkPath = path.join(outDir, spkAssetName());
  fs.rmSync(spkPath, { force: true });
  // DSM expects the .spk itself to be a plain tar archive; only package.tgz is gzip-compressed.
  const spkTar = run("tar", [
    ...tarOwnerArgs(),
    "-cf",
    spkPath,
    "-C",
    stageDir,
    "INFO",
    "PACKAGE_ICON.PNG",
    "PACKAGE_ICON_256.PNG",
    "conf",
    "scripts",
    "WIZARD_UIFILES",
    "package.tgz",
  ]);
  if (spkTar.status !== 0) {
    console.error(spkTar.stderr || spkTar.stdout || "SPK packaging failed");
    process.exit(spkTar.status || 1);
  }
  setTarEntryModes(spkPath, [
    "scripts/start-stop-status",
    "scripts/config",
    "scripts/preinst",
    "scripts/postinst",
    "scripts/preuninst",
    "scripts/preupgrade",
    "scripts/postupgrade",
    "WIZARD_UIFILES/install_uifile.sh",
    "WIZARD_UIFILES/upgrade_uifile.sh",
  ], false);
  console.log(`Synology DSM ${target.id} SPK built: ${path.relative(root, spkPath)}`);
}

preparePackageRoot();
console.log(`Synology DSM SPK source staged: ${path.relative(root, stageDir)}`);

if (stageOnly) {
  const archive = path.join(outDir, `${appName}-synology-v${version}-${target.assetSuffix}-spk-source.tgz`);
  const tar = run("tar", ["-czf", archive, "-C", stageDir, "."]);
  if (tar.status !== 0) {
    console.error(tar.stderr || tar.stdout || "tar failed");
    process.exit(tar.status || 1);
  }
  console.log(`Synology DSM stage-only archive: ${path.relative(root, archive)}`);
  process.exit(0);
}

try {
  buildSpk();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
