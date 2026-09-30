#!/usr/bin/env node

const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const rawVersion = process.env.SYNOLOGY_PACKAGE_VERSION || process.env.SYNOPKG_PACKAGE_VERSION || pkg.version || "0.1.0";
const verifyVersion = normalizeVersion(rawVersion);
const verifyTarget = normalizeTarget(process.env.SYNOLOGY_TARGET_ARCH || process.env.SYNOPKG_TARGET_ARCH || "x86_64");
const expectedDsmMinVersion = "7.0-40000";

function normalizeVersion(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/^refs\/tags\//, "")
    .replace(/^v(?=\d)/, "")
    .replace(/-synology(?:$|[.-].*)?$/, "");
  if (!/^0\.1\.\d+$/.test(normalized)) {
    fail(`SYNOLOGY_PACKAGE_VERSION must use 0.1.x format, got ${normalized || "(empty)"}.`);
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
      stageDirName: "mmh-spk",
      nodeArch: "x64",
    };
  }
  if (["arm", "arm64", "aarch64", "armv8"].includes(raw)) {
    return {
      id: "arm64",
      assetSuffix: "arm64",
      infoArch: "aarch64",
      stageDirName: "mmh-arm64-spk",
      nodeArch: "arm64",
    };
  }
  fail(`SYNOLOGY_TARGET_ARCH must be x86_64 or arm64, got ${value || "(empty)"}.`);
}

function fail(message) {
  console.error(`Synology package check failed: ${message}`);
  process.exit(1);
}

function expect(condition, message) {
  if (!condition) fail(message);
}

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function readJson(file) {
  try {
    return JSON.parse(read(file));
  } catch (error) {
    fail(`Unable to parse JSON ${path.relative(root, file)}: ${error.message}`);
  }
}

function hashFileMd5(file) {
  const hash = crypto.createHash("md5");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd || root,
    stdio: options.stdio || "pipe",
    shell: false,
    encoding: "utf8",
  });
}

function spkAssetName() {
  return `mmh-synology-v${verifyVersion}-${verifyTarget.assetSuffix}.spk`;
}

function builtSpkPath() {
  return process.env.SYNOLOGY_VERIFY_SPK_PATH
    ? path.resolve(root, process.env.SYNOLOGY_VERIFY_SPK_PATH)
    : path.join(root, "release-artifacts", "synology", spkAssetName());
}

function isGzipFile(file) {
  const header = Buffer.alloc(2);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, header, 0, 2, 0);
  } finally {
    fs.closeSync(fd);
  }
  return header[0] === 0x1f && header[1] === 0x8b;
}

function tarList(file, options = {}) {
  const result = run("tar", [options.gzip ? "-tzf" : "-tf", file]);
  expect(result.status === 0, `Unable to inspect tar archive ${path.relative(root, file)}.`);
  return (result.stdout || "").split(/\r?\n/).filter(Boolean).map((entry) => entry.replace(/^\.\//, ""));
}

function tarHas(entries, entry) {
  return entries.includes(entry) || entries.includes(`./${entry}`);
}

function parseInfo(text) {
  const info = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([^=\s]+)="(.*)"$/);
    if (match) info[match[1]] = match[2];
  }
  return info;
}

function readPngDimensions(file) {
  const buffer = fs.readFileSync(file);
  expect(buffer.subarray(0, 8).toString("hex") === "89504e470d0a1a0a", `${path.basename(file)} must be a PNG file.`);
  expect(buffer.subarray(12, 16).toString("ascii") === "IHDR", `${path.basename(file)} must contain an IHDR chunk.`);
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function parseTarOctal(buffer, start, length) {
  const raw = buffer.subarray(start, start + length).toString("ascii").replace(/\0.*$/, "").trim();
  return raw ? Number.parseInt(raw, 8) : 0;
}

function parseTarHeaders(file, options = {}) {
  const source = fs.readFileSync(file);
  const buffer = options.gzip ? zlib.gunzipSync(source) : source;
  const entries = new Map();
  for (let offset = 0; offset + 512 <= buffer.length;) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const fullName = (prefix ? `${prefix}/${name}` : name).replace(/^\.\//, "");
    const size = parseTarOctal(header, 124, 12);
    entries.set(fullName, {
      name: fullName,
      mode: parseTarOctal(header, 100, 8),
      uid: parseTarOctal(header, 108, 8),
      gid: parseTarOctal(header, 116, 8),
      size,
      type: header.subarray(156, 157).toString("ascii") || "0",
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function verifyExecutableTarEntry(entries, name, context) {
  const entry = entries.get(name);
  expect(entry, `${context} tar must contain ${name}.`);
  expect((entry.mode & 0o111) !== 0, `${context} ${name} must be executable in the SPK tar header.`);
}

function verifyRootOwnedTarEntry(entries, name, context) {
  const entry = entries.get(name);
  expect(entry, `${context} tar must contain ${name}.`);
  expect(entry.uid === 0 && entry.gid === 0, `${context} ${name} must be archived as root:root.`);
}

function verifyPrivilegeConfig(config, context) {
  const defaults = config && typeof config.defaults === "object" ? config.defaults : {};
  expect(defaults["run-as"] === "package", `${context} conf/privilege must run as the package user, not root.`);
  expect(!Object.prototype.hasOwnProperty.call(defaults, "run_as"), `${context} conf/privilege must use Synology's run-as key, not run_as.`);
  expect(config.username === "mmh", `${context} conf/privilege must create/use the mmh package user.`);
  expect(config.groupname === "mmh", `${context} conf/privilege must create/use the mmh package group.`);
}

function verifySourceFiles() {
  const packageJson = read(path.join(root, "package.json"));
  const appBuildScript = read(path.join(root, "scripts", "build-synology-app.cjs"));
  const packageScript = read(path.join(root, "scripts", "build-synology-package.cjs"));
  const manual = read(path.join(root, "deploy", "nas-install-manual.md"));
  const fnosBuildScript = read(path.join(root, "scripts", "build-fnos-package.cjs"));
  const releaseWorkflow = read(path.join(root, ".github", "workflows", "synology-release.yml"));
  const sqliteInitIndex = packageScript.indexOf('"$NODE_BIN" "$SERVER_DIR/scripts/init-sqlite.cjs"');
  const pidCheckIndex = packageScript.indexOf('if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")"');

  expect(/build:synology:app/.test(packageJson), "package.json must expose build:synology:app.");
  expect(/build:synology/.test(packageJson), "package.json must expose build:synology.");
  expect(/check:synology/.test(packageJson), "package.json must expose check:synology.");
  expect(/MMH_DEPLOY_TARGET:\s*"synology"/.test(appBuildScript), "Synology app build must mark the deployment target.");
  expect(/MMH_DEPLOY_TARGET=synology/.test(packageScript), "Synology start script must mark runtime deployment as synology.");
  const infoWriter = packageScript.slice(packageScript.indexOf("function writeInfoFile("), packageScript.indexOf("function writeInstallWizard()"));
  expect(!/adminport=/.test(infoWriter) && !/adminurl=/.test(infoWriter), "Synology source INFO must not reserve a fixed DSM web port before the install wizard runs.");
  expect(
    /build-fnos-package\.cjs/.test(packageScript) &&
      /20260922_add_account_balance_recomputed_at/.test(fnosBuildScript) &&
      /addColumnIfMissing\(db, "Account", "balanceRecomputedAt", "DATETIME"\)/.test(fnosBuildScript),
    "Synology packages must reuse the fnOS SQLite migration that adds Account.balanceRecomputedAt for existing databases.",
  );
  expect(/DATABASE_URL="file:\$DATA_DIR\/mmh\.db"/.test(packageScript), "Synology start script must store SQLite data under the package data directory.");
  expect(
    /MMH_NODE_MAX_OLD_SPACE_MB/.test(packageScript) &&
      /apply_node_memory_limit/.test(packageScript) &&
      /recommended_node_old_space_mb/.test(packageScript) &&
      /detect_runtime_memory_limit_mb/.test(packageScript) &&
      /MMH_NODE_MAX_OLD_SPACE_MB="\\\$\{MMH_NODE_MAX_OLD_SPACE_MB:-auto\}"/.test(packageScript) &&
      /--max-old-space-size=\$MMH_NODE_MAX_OLD_SPACE_MB/.test(packageScript),
    "Synology start script must apply the Node old-space guardrail before launching the server.",
  );
  expect(/VAR_DIR="\\\$\{SYNOPKG_PKGVAR:-\/var\/packages\/\$PACKAGE\/var\}"/.test(packageScript), "Synology runtime data must use SYNOPKG_PKGVAR, not the package target directory.");
  expect(!/^VAR_DIR="\$APP_DIR\/var"/m.test(packageScript), "Synology runtime data must not be written under SYNOPKG_PKGDEST/target.");
  expect(/package="\$\{appName\}"/.test(packageScript) && /const appName = "mmh"/.test(packageScript), "Synology INFO must keep the stable package id mmh.");
  expect(/const dsmAppName = "com\.synocommunity\.packages\.mmh"/.test(packageScript) && /dsmappname="\$\{dsmAppName\}"/.test(packageScript), "Synology INFO must declare a stable DSM application name for the web entry.");
  expect(
    /const dsmUiDir = "ui"/.test(packageScript) && /dsmuidir="\$\{dsmUiDir\}"/.test(packageScript),
    "Synology INFO must declare dsmuidir; without it DSM links no UI folder and Package Center shows neither the open button nor the icon.",
  );
  expect(
    /function writeDsmAppConfig\(\)/.test(packageScript) &&
      /function dsmUiDirs\(\)/.test(packageScript) &&
      /path\.join\(packageRoot, dir, "config"\)/.test(packageScript),
    "Synology package must generate the DSM web entry configuration inside the dsmuidir folder of package.tgz.",
  );
  expect(/dsmIconSizes = \[16, 24, 32, 48, 64, 72, 256\]/.test(packageScript) && /mmh-\$\{size\}\.png/.test(packageScript), "Synology package must generate all DSM web entry icon sizes.");
  expect(/path\.join\(packageRoot, dir, "images", `mmh-\$\{size\}\.png`\)/.test(packageScript), "Synology web entry icons must live in <dsmuidir>/images so DSM can resolve the icon template.");
  expect(/function writeInstallWizard\(\)/.test(packageScript) && /key: "wizard_port"/.test(packageScript), "Synology package must provide an install-time service port field.");
  expect(
    /function writeUpgradeWizard\(\)/.test(packageScript) &&
      /"upgrade_uifile"/.test(packageScript) &&
      !/config_uifile/.test(packageScript),
    "Synology package must expose the port field through upgrade_uifile; config_uifile is not a DSM wizard file and never renders.",
  );
  expect(
    /function assertWizardJsonFragments\(\)/.test(packageScript) &&
      /assertWizardJsonFragments\(\);/.test(packageScript) &&
      /const wizardJsonHead =/.test(packageScript) &&
      /const wizardJsonMid =/.test(packageScript) &&
      /const wizardJsonTail =/.test(packageScript),
    "Synology wizard JSON must be assembled from fragments that are validated at build time; a missing bracket otherwise ships silently and leaves the DSM wizard blank.",
  );
  expect(
    /write\(path\.join\(stageDir, "WIZARD_UIFILES", "install_uifile\.sh"\)/.test(packageScript) &&
      /write\(path\.join\(stageDir, "WIZARD_UIFILES", "upgrade_uifile\.sh"\)/.test(packageScript) &&
      /SYNOPKG_TEMP_LOGFILE/.test(packageScript) &&
      /Never exits non-zero/.test(packageScript),
    "Synology package must probe the port in a dynamic install/upgrade wizard script so the wizard can report an occupied port before the user presses next.",
  );
  expect(
    /probe_free_port \\\$\(\(port \+ 1\)\)/.test(packageScript) &&
      /被占用/.test(packageScript) &&
      /已预填/.test(packageScript),
    "Synology wizard must name a foreign conflicting owner and pre-fill the next free port instead of silently accepting an occupied one.",
  );
  expect(
    /own_only/.test(packageScript) &&
      /is_own_mmh_listener/.test(packageScript) &&
      /由 MMH 自身占用/.test(packageScript) &&
      /port_listener_pids "\$port"/.test(packageScript),
    "Synology wizard must keep the persisted port when every listener belongs to this package (the previous MMH is still running while DSM renders the upgrade wizard) and only advance for a foreign owner.",
  );
  // DSM renders the wizard field description as a full-width block under the
  // step title. It wraps, but the dialog height is fixed, so an over-long text
  // gets truncated mid-sentence. The previous message was 87 characters
  // ("端口 7779 已被占用（pid=32095 (next-server (v1），已预填下一个可用端口
  // 7780。更新会沿用当前端口；如需更换端口，在此填写新端口即可。" plus a warning
  // emoji) and was cut off on the second line on DSM 7.2.
  const wizardTexts = [
    ...(packageScript.match(/desc="[^"]*"/g) || []).map((entry) => entry.slice(6, -1)),
    ...(packageScript.match(/const (?:install|upgrade)Wizard(?:Suffix|OwnDesc) = "[^"]*"/g) || [])
      .map((entry) => entry.replace(/^const \w+ = "/, "").replace(/"$/, "")),
  ].filter((entry) => !entry.startsWith("$("));
  const longestWizardText = wizardTexts.reduce(
    (max, entry) => Math.max(max, entry.replace(/\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g, "").length),
    0,
  );
  expect(
    wizardTexts.length >= 6 && longestWizardText <= 30 && !/⚠️/.test(packageScript),
    `Synology wizard descriptions must stay within the DSM wizard's fixed-height description block (longest fixed text: ${longestWizardText} chars, budget 30); a longer message is truncated mid-sentence.`,
  );
  expect(/WIZARD_UIFILES.*install_uifile/.test(packageScript) && /WIZARD_UIFILES.*uninstall_uifile/.test(packageScript), "Synology install and uninstall wizards must use the DSM WIZARD_UIFILES paths.");
  expect(/JSON\.stringify\(\[\{\s*step_title:/.test(packageScript), "Synology wizard definitions must use DSM's top-level step array format.");
  expect(/description="家庭记账与财务管理应用/.test(packageScript), "Synology package description must explain MMH's purpose and local database behavior.");
  expect(/function writeUninstallWizard\(\)/.test(packageScript) && /key: "wizard_delete_data"/.test(packageScript), "Synology package must provide an uninstall data-retention choice.");
  expect(/wizard_delete_data:-false/.test(packageScript) && /MMH database and settings retained/.test(packageScript), "Synology uninstall must preserve data unless deletion is explicitly selected.");
  expect(/for entry in "\$VAR_DIR"\/\* "\$VAR_DIR"\/\.\[!\.\]\* "\$VAR_DIR"\/\.\.\?\*/.test(packageScript), "Synology uninstall must clear only the MMH package data directory contents when requested.");
  expect(
    /wizard_port_value:-7777/.test(packageScript) &&
      /ensure_port_available/.test(packageScript) &&
      /Choose a different.*port/.test(packageScript) &&
      /port_listener_inodes/.test(packageScript) &&
      /process_owns_port/.test(packageScript) &&
      /readlink \"\/proc\/\$pid\/exe\"/.test(packageScript) &&
      /\/proc\/\$pid\/cgroup/.test(packageScript),
    "Synology package must distinguish the MMH package process from Docker or other services before reusing an occupied port.",
  );
  expect(/previous_port=/.test(packageScript) && /port_source="existing installation"/.test(packageScript), "Synology postinst must preserve an existing port during upgrade.");
  expect(
    /probe_free_port/.test(packageScript) &&
      /auto-advanced from/.test(packageScript) &&
      /ensure_port_available "\$port"; then/.test(packageScript),
    "Synology postinst must auto-advance to the next free port instead of failing the install when the requested port is taken.",
  );
  expect(/\/proc\/net\/tcp/.test(packageScript) && /\/proc\/net\/tcp6/.test(packageScript), "Synology port checks must work when DSM does not provide netstat.");
  const listenerInodePrints = packageScript.match(/\) print \$\d+/g) || [];
  expect(listenerInodePrints.length === 4 && listenerInodePrints.every((entry) => entry === ") print $10") && !/print \$12/.test(packageScript), "Synology port ownership checks must read the socket inode field from /proc/net/tcp*.");
  expect(/write\(path\.join\(stageDir, "scripts", "config"\)/.test(packageScript), "Synology package must include a config callback for changing the service port.");
  expect(
    /function writePreinstScript\(\)/.test(packageScript) &&
      /path\.join\(stageDir, "scripts", "preinst"\)/.test(packageScript) &&
      /report_preinst_message/.test(packageScript) &&
      /is not a valid TCP port between 1 and 65535/.test(packageScript) &&
      !/安装已中止/.test(packageScript),
    "Synology preinst must abort only for an invalid port value, never for a port occupied by another program.",
  );
  expect(
    /is_own_mmh_listener/.test(packageScript) &&
      /port_listener_pids/.test(packageScript) &&
      /process_is_containerized/.test(packageScript) &&
      /OWN_SERVER_JS="\/var\/packages\/\$PACKAGE\/target\/app\/server\/server\.js"/.test(packageScript) &&
      /Docker 端口映射/.test(packageScript) &&
      /Docker\/容器进程/.test(packageScript),
    "Synology install-time port checks must treat Docker-hosted MMH, other packages and unrelated services as foreign owners.",
  );
  expect(
    /const portIdentityShell = /.test(packageScript) &&
      /process_belongs_to_package\(\)/.test(packageScript) &&
      /pkgctl-\$PACKAGE/.test(packageScript) &&
      /process_runs_our_server\(\)/.test(packageScript) &&
      /@appstore\/\$PACKAGE\/app\/bin\/node/.test(packageScript) &&
      /process_belongs_to_package "\$pid" && return 0/.test(packageScript),
    "Synology own-process detection must go through the package cgroup (with the resolved @appstore node path as fallback): Next.js rewrites argv[0] to \"next-server (vX)\" and /var/packages/<pkg>/target is a symlink, so matching cmdline/exe against the unresolved target path never recognises our own listener.",
  );
  expect(
    !/readlink "\/proc\/\$pid\/exe" 2>\/dev\/null\)" = "\$NODE_BIN"/.test(packageScript) &&
      !/readlink "\/proc\/\$pid\/exe" 2>\/dev\/null\)" = "\$APP_DIR\/app\/bin\/node"/.test(packageScript),
    "Synology lifecycle scripts must not compare /proc/<pid>/exe against the unresolved $APP_DIR node path: /var/packages/<pkg>/target is a symlink to /volumeX/@appstore/<pkg>.",
  );
  expect(
    /installation continues and will switch to the next free port/.test(packageScript) &&
      !/MMH install cannot continue/.test(packageScript) &&
      /probe_free_port/.test(packageScript) &&
      /auto-advanced from/.test(packageScript),
    "Synology install-time port conflicts must warn and auto-advance instead of failing the install.",
  );
  expect(
    /setTarEntryModes\(spkPath, \[[\s\S]*"scripts\/preinst"[\s\S]*\], false\)/.test(packageScript),
    "Synology SPK tar must mark scripts/preinst as executable.",
  );
  expect(
    /"WIZARD_UIFILES\/install_uifile\.sh",\s*\n\s*"WIZARD_UIFILES\/upgrade_uifile\.sh",/.test(packageScript),
    "Synology SPK tar must mark the dynamic wizard scripts as executable; DSM only runs them when they are.",
  );
  expect(/chown mmh:mmh "\$ENV_FILE" 2>\/dev\/null \|\| true/.test(packageScript), "Synology postinst must not fail when the package user cannot change file ownership.");
  expect(/chown mmh:mmh "\$VAR_DIR\/mmh\.env" 2>\/dev\/null \|\| true/.test(packageScript), "Synology upgrade scripts must not fail when the package user cannot change file ownership.");
  expect(
    /mmh-wizard-port/.test(packageScript) &&
      /wizard_port_value" != "\$wizard_recorded_port/.test(packageScript) &&
      /port_source="installer selection"/.test(packageScript),
    "Synology postinst must honour the wizard port only when the user changed the wizard's own default; the wizard records that default in mmh-wizard-port so an untouched upgrade never leaves the port it is on.",
  );
  expect(/if \[ -z "\$port" \]; then\n  port="\\\$\{wizard_port_value:-7777\}"/.test(packageScript), "Synology postinst must initialize the port from the install wizard on first install.");
  expect(/update_dsm_app_config/.test(packageScript) && /app\/config/.test(packageScript), "Synology lifecycle scripts must update the DSM app entry configuration.");
  expect(/安装向导/.test(manual) && /服务端口/.test(manual), "Synology install documentation must explain the install-time service port.");
  expect(/const dsmMinVersion = "7\.0-40000"/.test(packageScript), "Synology INFO must keep the DSM compatibility floor at 7.0-40000.");
  expect(/checksumLine/.test(packageScript) && /extractSizeLine/.test(packageScript), "Synology INFO must write checksum and extractsize for DSM package validation.");
  expect(/hashFileMd5/.test(packageScript) && /directorySizeKb/.test(packageScript), "Synology package build must calculate checksum and extractsize.");
  expect(/tarOwnerArgs/.test(packageScript), "Synology package build must archive release tarballs with stable numeric root ownership.");
  expect(/"run-as":\s*"package"/.test(packageScript), "Synology privilege config must use run-as=package.");
  expect(!/run_as:\s*"package"/.test(packageScript), "Synology privilege config must not use the invalid run_as key.");
  expect(/\$\{appName\}-synology-v\$\{version\}-\$\{target\.assetSuffix\}\.spk/.test(packageScript), "Synology SPK asset names must include version and architecture.");
  expect(!/"-czf",\s*spkPath/.test(packageScript), "Synology SPK outer archive must be uncompressed tar; only package.tgz should be gzip-compressed.");
  expect(sqliteInitIndex !== -1 && pidCheckIndex !== -1 && sqliteInitIndex < pidCheckIndex, "Synology start script must run SQLite init before returning for an already-running process.");
  expect(/release-artifacts\/synology\/\*\.spk/.test(releaseWorkflow), "Synology release workflow must upload SPK assets.");
  expect(/target_arch/.test(releaseWorkflow) && /arm64/.test(releaseWorkflow), "Synology release workflow must build x86_64 and arm64 packages.");
}

function verifyStagedSource() {
  const stageDir = path.join(root, "release-artifacts", "synology", verifyTarget.stageDirName);
  if (!fs.existsSync(stageDir)) return;
  if (!fs.existsSync(path.join(stageDir, "INFO"))) return;
  const info = read(path.join(stageDir, "INFO"));
  const startScript = read(path.join(stageDir, "scripts", "start-stop-status"));
  const installWizard = readJson(path.join(stageDir, "WIZARD_UIFILES", "install_uifile"));
  const upgradeWizard = readJson(path.join(stageDir, "WIZARD_UIFILES", "upgrade_uifile"));
  const uninstallWizard = readJson(path.join(stageDir, "WIZARD_UIFILES", "uninstall_uifile"));
  const installWizardScript = read(path.join(stageDir, "WIZARD_UIFILES", "install_uifile.sh"));
  const upgradeWizardScript = read(path.join(stageDir, "WIZARD_UIFILES", "upgrade_uifile.sh"));
  const postinst = read(path.join(stageDir, "scripts", "postinst"));
  const preinst = read(path.join(stageDir, "scripts", "preinst"));
  const privilege = readJson(path.join(stageDir, "conf", "privilege"));
  expect(new RegExp(`version="${verifyVersion}"`).test(info), "Staged INFO must contain the package version.");
  expect(new RegExp(`arch="${verifyTarget.infoArch}"`).test(info), "Staged INFO must contain the target architecture.");
  expect(new RegExp(`os_min_ver="${expectedDsmMinVersion}"`).test(info), "Staged INFO must keep the DSM compatibility floor at 7.0-40000.");
  expect(/dsmappname="com\.synocommunity\.packages\.mmh"/.test(info), "Staged INFO must declare the stable DSM application name.");
  expect(/^dsmuidir="ui"$/m.test(info), "Staged INFO must declare dsmuidir so DSM links the UI folder and shows the open button plus icon.");
  expect(!/^adminport=/m.test(info) && !/^adminurl=/m.test(info), "Staged INFO must not reserve a fixed DSM web port before installation.");
  verifyPrivilegeConfig(privilege, "Staged");
  expect(installWizard[0]?.items?.[0]?.subitems?.[0]?.key === "wizard_port", "Staged DSM install wizard must expose the service port field.");
  expect(upgradeWizard[0]?.items?.[0]?.subitems?.[0]?.key === "wizard_port", "Staged DSM upgrade wizard must expose the service port field so the port stays editable after installation.");
  expect(
    !fs.existsSync(path.join(stageDir, "WIZARD_UIFILES", "config_uifile")),
    "Staged package must not carry config_uifile: DSM only renders install/upgrade/uninstall wizard files.",
  );
  expect(uninstallWizard[0]?.items?.[0]?.subitems?.some((item) => item.key === "wizard_delete_data" && item.defaultValue === false), "Staged DSM uninstall wizard must offer data deletion and default to keeping user data.");
  const stagedIcon = readPngDimensions(path.join(stageDir, "PACKAGE_ICON.PNG"));
  const stagedIcon256 = readPngDimensions(path.join(stageDir, "PACKAGE_ICON_256.PNG"));
  expect(stagedIcon.width === 72 && stagedIcon.height === 72, "Staged PACKAGE_ICON.PNG must be 72x72.");
  expect(stagedIcon256.width === 256 && stagedIcon256.height === 256, "Staged PACKAGE_ICON_256.PNG must be 256x256.");
  for (const dsmUiDir of ["ui", "app", path.join("app", "ui")]) {
    const stagedDsmConfig = readJson(path.join(stageDir, "package", dsmUiDir, "config"));
    const stagedDsmEntry = stagedDsmConfig?.[".url"]?.["com.synocommunity.packages.mmh"];
    expect(
      stagedDsmEntry?.type === "url" && stagedDsmEntry?.protocol === "http" && stagedDsmEntry?.port === "7777" && stagedDsmEntry?.icon === "images/mmh-{0}.png",
      `Staged package/${dsmUiDir}/config must define the MMH web entry and default port.`,
    );
    expect(
      Object.keys(stagedDsmConfig?.[".url"] ?? {}).every((key) => key === "com.synocommunity.packages.mmh"),
      `Staged package/${dsmUiDir}/config must not declare an application id other than dsmappname.`,
    );
  }
  for (const dsmUiDir of ["ui", "app", path.join("app", "ui")]) {
    for (const size of [16, 24, 32, 48, 64, 72, 256]) {
      const icon = readPngDimensions(path.join(stageDir, "package", dsmUiDir, "images", `mmh-${size}.png`));
      expect(icon.width === size && icon.height === size, `Staged package/${dsmUiDir}/images/mmh-${size}.png must be ${size}x${size}.`);
    }
  }
  expect(/wizard_port_value:-7777/.test(postinst) && /ensure_port_available/.test(postinst) && /Choose a different.*port/.test(postinst) && /process_owns_port/.test(postinst), "Staged postinst must identify the owning process before reusing an occupied service port.");
  expect(
    /is_own_mmh_listener/.test(preinst) &&
      /port_is_listening/.test(preinst) &&
      /report_preinst_message/.test(preinst) &&
      /installation continues/.test(preinst) &&
      /Docker 端口映射/.test(preinst),
    "Staged preinst must warn about a foreign port owner without aborting the install.",
  );
  expect(
    /probe_free_port/.test(postinst) && /auto-advanced/.test(postinst),
    "Staged postinst must advance to the next free port when the requested port is owned by another program.",
  );
  expect(
    /^update_dsm_wizard_defaults\(\) \{/m.test(postinst) && /update_dsm_wizard_defaults "\$port"/.test(postinst),
    "Staged postinst must define update_dsm_wizard_defaults before calling it; DSM logged 'update_dsm_wizard_defaults: command not found' on every install because only start-stop-status and config defined it.",
  );
  for (const [name, script] of [["install_uifile.sh", installWizardScript], ["upgrade_uifile.sh", upgradeWizardScript]]) {
    expect(
      /^#!\/bin\/sh/m.test(script) && /SYNOPKG_TEMP_LOGFILE/.test(script) && /exit 0\s*$/.test(script.trimEnd()),
      `Staged WIZARD_UIFILES/${name} must write the wizard JSON to SYNOPKG_TEMP_LOGFILE and always exit 0.`,
    );
    expect(
      /\[ -n "\$OUT" \] \|\| exit 0/.test(script) && /被占用/.test(script) && /已预填/.test(script),
      `Staged WIZARD_UIFILES/${name} must report a foreign occupied port and pre-fill the next free one.`,
    );
    expect(
      /own_only=1/.test(script) && /is_own_mmh_listener "\$pid"/.test(script) && /由 MMH 自身占用/.test(script) && !/undefined/.test(script),
      `Staged WIZARD_UIFILES/${name} must keep the port when every listener is this package's own running instance, so an upgrade never walks off the port the user is on.`,
    );
    expect(
      /process_belongs_to_package/.test(script) && /pkgctl-\$PACKAGE/.test(script),
      `Staged WIZARD_UIFILES/${name} must detect the package's own process through its DSM cgroup.`,
    );
    expect(
      /printf '%s' '\[\\?\{\\?"step_title"/.test(script) || /printf '%s' '\$\{wizardJsonHead\}'/.test(script),
      `Staged WIZARD_UIFILES/${name} must build the wizard JSON from the validated fragment.`,
    );
    expect(
      /mmh-wizard-port/.test(script) && /printf '%s\\n' "\$port" > "\$WIZARD_PORT_RECORD"/.test(script),
      `Staged WIZARD_UIFILES/${name} must record the port it pre-filled, so postinst can tell a user edit from the default it proposed.`,
    );
    const longestDesc = (script.match(/desc="[^"]*"/g) || [])
      .map((entry) => entry.slice(6, -1))
      .filter((entry) => !entry.startsWith("$("))
      .reduce((max, entry) => Math.max(max, entry.replace(/\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g, "").length), 0);
    expect(
      longestDesc > 0 && longestDesc <= 30 && !/⚠️/.test(script),
      `Staged WIZARD_UIFILES/${name} description must fit the DSM wizard field (longest fixed text: ${longestDesc} chars, budget 30); 88 characters overflowed the window on DSM 7.2.`,
    );
  }
  for (const [name, wizard] of [["install_uifile", installWizard], ["upgrade_uifile", upgradeWizard]]) {
    const stagedDesc = wizard[0]?.items?.[0]?.subitems?.[0]?.desc ?? "";
    expect(
      stagedDesc.length > 0 && stagedDesc.length <= 30,
      `Staged WIZARD_UIFILES/${name} static description must stay within the wizard field (${stagedDesc.length} chars, budget 30).`,
    );
  }
  expect(
    /process_belongs_to_package/.test(postinst) && /process_belongs_to_package/.test(startScript) && /process_belongs_to_package/.test(preinst),
    "Staged lifecycle scripts must all share the cgroup-based own-process detection.",
  );
  expect(
    /\[ -w "\$wizard_dir" \] \|\| return 0/.test(startScript),
    "Staged start-stop-status must skip the WIZARD_UIFILES rewrite when DSM's root-owned directory is not writable; running as the package user logged 'Permission denied' on every start.",
  );
  expect(/previous_port=/.test(postinst) && /port_source="existing installation"/.test(postinst), "Staged postinst must preserve an existing port during upgrade.");
  expect(
    /mmh-wizard-port/.test(postinst) &&
      /mmh-wizard-port/.test(preinst) &&
      /mmh-wizard-port/.test(upgradeWizardScript) &&
      /wizard_port_value" != "\$wizard_recorded_port/.test(postinst) &&
      /wizard_port_value" != "\$wizard_recorded_port/.test(preinst),
    "Staged lifecycle scripts must share the wizard-default record: the wizard writes mmh-wizard-port and preinst/postinst honour a wizard value only when the user changed it.",
  );
  expect(/ensure_port_available/.test(startScript) && /Port .* is occupied/.test(startScript) && /Choose a different.*port/.test(startScript) && /process_owns_port/.test(startScript), "Staged start-stop-status must identify the owning process before reusing an occupied service port.");
  expect(/MMH_DEPLOY_TARGET=synology/.test(startScript), "Staged start-stop-status must mark runtime deployment as synology.");
  expect(
    /MMH_NODE_MAX_OLD_SPACE_MB/.test(startScript) &&
      /apply_node_memory_limit/.test(startScript) &&
      /recommended_node_old_space_mb/.test(startScript) &&
      /detect_runtime_memory_limit_mb/.test(startScript) &&
      /MMH_NODE_MAX_OLD_SPACE_MB="\$\{MMH_NODE_MAX_OLD_SPACE_MB:-auto\}"/.test(startScript),
    "Staged start-stop-status must apply the Node old-space guardrail.",
  );
  expect(fs.existsSync(path.join(stageDir, "package", "app", "server", "server.js")), "Staged package must contain the Next standalone server.");
  expect(fs.existsSync(path.join(stageDir, "package", "app", "bin", "node")), `Staged package must contain a Linux ${verifyTarget.nodeArch} Node runtime.`);
}

function verifyBuiltSpk() {
  const spkPath = builtSpkPath();
  expect(fs.existsSync(spkPath), `Built Synology ${verifyTarget.id} SPK must exist before upload.`);
  expect(!isGzipFile(spkPath), "Built SPK must be an uncompressed tar archive; only package.tgz should be gzip-compressed.");
  const tarHeaders = parseTarHeaders(spkPath);
  const entries = tarList(spkPath);
  for (const required of [
    "INFO",
    "PACKAGE_ICON.PNG",
    "PACKAGE_ICON_256.PNG",
    "conf/privilege",
    "scripts/start-stop-status",
    "scripts/config",
    "scripts/preinst",
    "scripts/postinst",
    "scripts/preupgrade",
    "scripts/postupgrade",
    "package.tgz",
    "WIZARD_UIFILES/install_uifile",
    "WIZARD_UIFILES/install_uifile.sh",
    "WIZARD_UIFILES/upgrade_uifile",
    "WIZARD_UIFILES/upgrade_uifile.sh",
    "WIZARD_UIFILES/uninstall_uifile",
  ]) {
    expect(tarHas(entries, required), `Built SPK must contain ${required}.`);
  }
  expect(!tarHas(entries, "WIZARD_UIFILES/config_uifile"), "Built SPK must not contain config_uifile: DSM only renders install/upgrade/uninstall wizard files.");
  for (const executable of [
    "scripts/start-stop-status",
    "scripts/config",
    "scripts/preinst",
    "scripts/postinst",
    "scripts/preuninst",
    "scripts/preupgrade",
    "scripts/postupgrade",
    "WIZARD_UIFILES/install_uifile.sh",
    "WIZARD_UIFILES/upgrade_uifile.sh",
  ]) {
    verifyExecutableTarEntry(tarHeaders, executable, "Built SPK");
  }
  for (const rootOwned of ["INFO", "conf/privilege", "package.tgz"]) {
    verifyRootOwnedTarEntry(tarHeaders, rootOwned, "Built SPK");
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mmh-synology-spk-"));
  try {
    const extract = run("tar", ["-xf", spkPath, "-C", tmpDir, "package.tgz"]);
    expect(extract.status === 0, "Unable to extract package.tgz from built SPK.");
    fs.mkdirSync(path.join(tmpDir, "conf"), { recursive: true });
    const metadataExtract = run("tar", ["-xf", spkPath, "-C", tmpDir, "INFO", "PACKAGE_ICON.PNG", "PACKAGE_ICON_256.PNG", "conf/privilege"]);
    expect(metadataExtract.status === 0, "Unable to extract INFO and conf/privilege from built SPK.");
    const builtInfo = read(path.join(tmpDir, "INFO"));
    const wizardExtract = run("tar", ["-xf", spkPath, "-O", "WIZARD_UIFILES/install_uifile"]);
    expect(wizardExtract.status === 0, "Unable to read the install wizard from built SPK.");
    const builtInstallWizard = JSON.parse(wizardExtract.stdout || "{}");
    expect(Array.isArray(builtInstallWizard) && builtInstallWizard[0]?.items?.[0]?.subitems?.[0]?.key === "wizard_port", "Built DSM install wizard must expose the service port field.");
    const upgradeWizardExtract = run("tar", ["-xf", spkPath, "-O", "WIZARD_UIFILES/upgrade_uifile"]);
    expect(upgradeWizardExtract.status === 0, "Unable to read the DSM upgrade wizard from built SPK.");
    const builtUpgradeWizard = JSON.parse(upgradeWizardExtract.stdout || "{}");
    expect(Array.isArray(builtUpgradeWizard) && builtUpgradeWizard[0]?.items?.[0]?.subitems?.[0]?.key === "wizard_port", "Built DSM upgrade wizard must expose the service port field.");
    const installWizardScriptExtract = run("tar", ["-xf", spkPath, "-O", "WIZARD_UIFILES/install_uifile.sh"]);
    expect(installWizardScriptExtract.status === 0, "Unable to read the dynamic install wizard from built SPK.");
    const builtInstallWizardScript = installWizardScriptExtract.stdout || "";
    expect(
      /SYNOPKG_TEMP_LOGFILE/.test(builtInstallWizardScript) &&
        /被占用/.test(builtInstallWizardScript) &&
        /已预填/.test(builtInstallWizardScript) &&
        /own_only=1/.test(builtInstallWizardScript) &&
        /由 MMH 自身占用/.test(builtInstallWizardScript) &&
        /pkgctl-\$PACKAGE/.test(builtInstallWizardScript) &&
        /exit 0\s*$/.test(builtInstallWizardScript.trimEnd()),
      "Built dynamic install wizard must probe the port, keep our own package's port, report a foreign owner, and always exit 0.",
    );
    const upgradeWizardScriptExtract = run("tar", ["-xf", spkPath, "-O", "WIZARD_UIFILES/upgrade_uifile.sh"]);
    expect(upgradeWizardScriptExtract.status === 0, "Unable to read the dynamic upgrade wizard from built SPK.");
    expect(
      /own_only=1/.test(upgradeWizardScriptExtract.stdout || "") &&
        /pkgctl-\$PACKAGE/.test(upgradeWizardScriptExtract.stdout || ""),
      "Built dynamic upgrade wizard must keep the persisted port when the listener is this package's own running instance.",
    );
    const uninstallWizardExtract = run("tar", ["-xf", spkPath, "-O", "WIZARD_UIFILES/uninstall_uifile"]);
    expect(uninstallWizardExtract.status === 0, "Unable to read the uninstall wizard from built SPK.");
    const builtUninstallWizard = JSON.parse(uninstallWizardExtract.stdout || "{}");
    expect(Array.isArray(builtUninstallWizard) && builtUninstallWizard[0]?.items?.[0]?.subitems?.some((item) => item.key === "wizard_delete_data" && item.defaultValue === false), "Built DSM uninstall wizard must offer data deletion and default to keeping user data.");
    const uninstallScript = run("tar", ["-xf", spkPath, "-O", "scripts/preuninst"]);
    expect(uninstallScript.status === 0, "Unable to read scripts/preuninst from built SPK.");
    expect(/wizard_delete_data:-false/.test(uninstallScript.stdout || "") && /for entry in "\$VAR_DIR"\/\* "\$VAR_DIR"\/\.\[!\.\]\* "\$VAR_DIR"\/\.\.\?\*/.test(uninstallScript.stdout || ""), "Built uninstall script must retain data by default and only clear the MMH data directory contents when requested.");
    const configScript = run("tar", ["-xf", spkPath, "-O", "scripts/config"]);
    expect(configScript.status === 0, "Unable to read scripts/config from built SPK.");
    expect(/wizard_port/.test(configScript.stdout || "") && /ensure_port_available/.test(configScript.stdout || "") && /process_owns_port/.test(configScript.stdout || "") && /mmh\.env/.test(configScript.stdout || "") && /for dsm_ui_dir in ui app app\/ui/.test(configScript.stdout || "") && /\$dsm_ui_dir\/config/.test(configScript.stdout || "") && /start-stop-status/.test(configScript.stdout || "") && /Choose a different.*port/.test(configScript.stdout || ""), "Built config callback must identify occupied ports, persist the selected service port, update DSM's app entry, and restart MMH.");
    const parsedInfo = parseInfo(builtInfo);
    expect(parsedInfo.version === verifyVersion, "Built INFO must contain the package version.");
    expect(parsedInfo.dsmappname === "com.synocommunity.packages.mmh", "Built INFO must contain the stable DSM application name.");
    expect(parsedInfo.dsmuidir === "ui", "Built INFO must contain dsmuidir=ui so DSM links the UI folder and shows the open button plus icon.");
    expect(new RegExp(`os_min_ver="${expectedDsmMinVersion}"`).test(builtInfo), "Built INFO must keep the DSM compatibility floor at 7.0-40000.");
    expect(/^[a-f0-9]{32}$/.test(parsedInfo.checksum || ""), "Built INFO must contain a package.tgz MD5 checksum.");
    expect(parsedInfo.checksum === hashFileMd5(path.join(tmpDir, "package.tgz")), "Built INFO checksum must match package.tgz.");
    expect(Number(parsedInfo.extractsize) > 0, "Built INFO must contain a positive extractsize value.");
    expect(parsedInfo.adminport === undefined && parsedInfo.adminurl === undefined, "Built INFO must not reserve a fixed DSM web port before installation.");
    const icon72 = path.join(tmpDir, "PACKAGE_ICON.PNG");
    const icon256 = path.join(tmpDir, "PACKAGE_ICON_256.PNG");
    const icon72Size = readPngDimensions(icon72);
    const icon256Size = readPngDimensions(icon256);
    expect(icon72Size.width === 72 && icon72Size.height === 72, "PACKAGE_ICON.PNG must be 72x72.");
    expect(icon256Size.width === 256 && icon256Size.height === 256, "PACKAGE_ICON_256.PNG must be 256x256.");
    verifyPrivilegeConfig(readJson(path.join(tmpDir, "conf", "privilege")), "Built");
    const packageTgzPath = path.join(tmpDir, "package.tgz");
    expect(isGzipFile(packageTgzPath), "Built package.tgz must remain gzip-compressed.");
    const startScript = run("tar", ["-xf", spkPath, "-O", "scripts/start-stop-status"]);
    expect(startScript.status === 0, "Unable to read scripts/start-stop-status from built SPK.");
    expect(/SYNOPKG_PKGVAR/.test(startScript.stdout || ""), "Built start-stop-status must use SYNOPKG_PKGVAR for writable runtime data.");
    expect(
      /MMH_NODE_MAX_OLD_SPACE_MB/.test(startScript.stdout || "") &&
        /apply_node_memory_limit/.test(startScript.stdout || "") &&
        /recommended_node_old_space_mb/.test(startScript.stdout || "") &&
        /detect_runtime_memory_limit_mb/.test(startScript.stdout || "") &&
        /MMH_NODE_MAX_OLD_SPACE_MB="\$\{MMH_NODE_MAX_OLD_SPACE_MB:-auto\}"/.test(startScript.stdout || ""),
      "Built start-stop-status must apply the Node old-space guardrail.",
    );
    expect(!/^VAR_DIR="\$APP_DIR\/var"/m.test(startScript.stdout || ""), "Built start-stop-status must not write runtime data under SYNOPKG_PKGDEST/target.");
    const packageEntries = tarList(packageTgzPath, { gzip: true });
    for (const required of [
      "app/bin/node",
      "app/server/server.js",
      "app/server/scripts/init-sqlite.cjs",
      "app/server/prisma/schema.native.prisma",
      "ui/config",
      "app/config",
      "app/ui/config",
      "ui/images/mmh-256.png",
      "app/images/mmh-256.png",
    ]) {
      expect(tarHas(packageEntries, required), `Built package.tgz must contain ${required}.`);
    }
    const payloadDir = path.join(tmpDir, "payload");
    fs.mkdirSync(payloadDir, { recursive: true });
    const dsmExtract = run("tar", ["-xzf", packageTgzPath, "-C", payloadDir]);
    expect(dsmExtract.status === 0, "Unable to extract DSM app config and icons from package.tgz.");
    for (const dsmUiDir of ["ui", "app", path.join("app", "ui")]) {
      const builtDsmConfig = readJson(path.join(payloadDir, dsmUiDir, "config"));
      const builtDsmEntry = builtDsmConfig?.[".url"]?.["com.synocommunity.packages.mmh"];
      expect(
        builtDsmEntry?.type === "url" && builtDsmEntry?.protocol === "http" && builtDsmEntry?.port === "7777" && builtDsmEntry?.icon === "images/mmh-{0}.png",
        `Built package/${dsmUiDir}/config must define the MMH web entry and default port.`,
      );
      expect(
        Object.keys(builtDsmConfig?.[".url"] ?? {}).every((key) => key === "com.synocommunity.packages.mmh"),
        `Built package/${dsmUiDir}/config must not declare an application id other than dsmappname.`,
      );
    }
    for (const size of [16, 24, 32, 48, 64, 72, 256]) {
      const icon = readPngDimensions(path.join(payloadDir, "ui", "images", `mmh-${size}.png`));
      expect(icon.width === size && icon.height === size, `Built DSM icon mmh-${size}.png must be ${size}x${size}.`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

verifySourceFiles();
verifyStagedSource();
if (process.env.SYNOLOGY_VERIFY_BUILT_SPK === "1") verifyBuiltSpk();
console.log(`Synology package checks passed for ${verifyTarget.id}.`);
