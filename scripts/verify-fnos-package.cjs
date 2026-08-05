#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const fnosDir = path.join(root, "deploy", "fnos");
const files = {
  compose: path.join(fnosDir, "docker-compose.yml"),
  env: path.join(fnosDir, "env.example"),
  readme: path.join(fnosDir, "README.md"),
  manifest: path.join(fnosDir, "manifest.example.json"),
  postgresInit: path.join(fnosDir, "postgres-entrypoint.sh"),
  repositoryApps: path.join(fnosDir, "repository", "apps.example.json"),
  repositoryReadme: path.join(fnosDir, "repository", "README.md"),
  fnosReleaseWorkflow: path.join(root, ".github", "workflows", "fnos-release.yml"),
};

const failures = [];

function read(fileKey) {
  const file = files[fileKey];
  if (!fs.existsSync(file)) {
    failures.push(`Missing ${path.relative(root, file)}`);
    return "";
  }
  return fs.readFileSync(file, "utf8");
}

function expect(condition, message) {
  if (!condition) failures.push(message);
}

const compose = read("compose");
const env = read("env");
const readme = read("readme");
const manifestText = read("manifest");
const repositoryAppsText = read("repositoryApps");
const repositoryReadme = read("repositoryReadme");
const fnosReleaseWorkflow = read("fnosReleaseWorkflow");
read("postgresInit");

expect(/MMH_DEPLOY_TARGET:\s*fnos/.test(compose), "Compose should mark MMH_DEPLOY_TARGET=fnos.");
expect(/"\$\{MMH_WEB_PORT:-7777\}:7777"/.test(compose), "Compose should expose only configurable Web port 7777.");
expect(!/env_file:\s*\n\s*-\s*\.env/.test(compose), "fnOS Compose should not require a missing .env file.");
expect(/MMH_COMPOSE_FILE:\s*\/workspace\/docker-compose\.yaml/.test(compose), "fnOS updater should point to docker-compose.yaml.");
expect(!/5433:5432/.test(compose) && !/"5432:5432"/.test(compose), "Compose must not expose Postgres to host.");
expect(/\/var\/run\/docker\.sock:\/var\/run\/docker\.sock/.test(compose), "Compose should explicitly declare updater Docker socket dependency.");
expect((compose.match(/no-new-privileges:true/g) ?? []).length >= 3, "All services should use no-new-privileges.");
expect(/postgres:\s*\n[\s\S]*healthcheck:/.test(compose), "Postgres should have a healthcheck.");
expect(/condition:\s*service_healthy/.test(compose), "App should wait for healthy Postgres.");

expect(/POSTGRES_PASSWORD="CHANGE_ME_TO_A_LONG_RANDOM_PASSWORD"/.test(env), "env.example should keep password placeholder.");
expect(!/sk-[a-zA-Z0-9]/.test(env), "env.example must not contain API keys.");
expect(!/password=.*[^"\n]+@/i.test(env), "env.example must not contain embedded private credentials.");
expect(/MMH_IMAGE_SOURCE="dockerproxy"/.test(env), "env.example should keep a reachable default image source.");
expect(/MMH_WEB_PORT="7777"/.test(env), "env.example should expose configurable Web port.");

expect(/不暴露 MMH Web 端口 `7777`|只暴露 MMH Web 端口 `7777`/.test(readme), "README should document exposed Web port.");
expect(/PostgreSQL 不映射到宿主机端口/.test(readme), "README should document that Postgres is not exposed.");
expect(/Docker socket/.test(readme), "README should document updater Docker socket caveat.");
expect(/\.fpk/.test(readme), "README should document .fpk as the release package.");
expect(/\.fpk/.test(repositoryReadme), "Repository README should document .fpk-only release packages.");
expect(/docker-project/.test(fs.readFileSync(path.join(root, "scripts", "build-fnos-package.cjs"), "utf8")), "Build script should declare fnOS docker-project resources.");
expect(/run-as": "package"/.test(fs.readFileSync(path.join(root, "scripts", "build-fnos-package.cjs"), "utf8")), "Build script should use fnOS Docker package privilege defaults.");
expect(/release:\s*\n\s*types:\s*\[published\]/.test(fnosReleaseWorkflow), "fnOS workflow should run when a GitHub Release is published.");
expect(/npm run build:fnos/.test(fnosReleaseWorkflow), "fnOS workflow should build the formal .fpk package.");
expect(/release-artifacts\/fnos\/\*\.fpk/.test(fnosReleaseWorkflow), "fnOS workflow should upload .fpk files.");
expect(!/release-artifacts\/fnos\/\*\.tgz/.test(fnosReleaseWorkflow), "fnOS workflow must not upload stage-only .tgz files.");
expect(/fnpack was not found/.test(fnosReleaseWorkflow), "fnOS workflow should fail clearly when fnpack is unavailable.");
expect(/Check existing Release FPK/.test(fnosReleaseWorkflow), "fnOS workflow should detect manually attached .fpk assets.");
expect(/steps\.existing-fpk\.outputs\.found != 'true'/.test(fnosReleaseWorkflow), "fnOS workflow should skip rebuilding when Release already has a .fpk asset.");

try {
  const manifest = JSON.parse(manifestText);
  expect(manifest.id === "mmh", "Manifest id should be mmh.");
  expect(Array.isArray(manifest.architectures) && manifest.architectures.length > 0, "Manifest should declare architectures.");
} catch (error) {
  failures.push(`manifest.example.json is not valid JSON: ${error.message}`);
}

try {
  const repositoryApps = JSON.parse(repositoryAppsText);
  const app = Array.isArray(repositoryApps.apps) ? repositoryApps.apps.find((item) => item?.id === "mmh") : null;
  expect(Boolean(app), "Repository apps example should include mmh.");
  expect(typeof app?.download_url === "string" && app.download_url.endsWith(".fpk"), "Repository download_url must point to a .fpk file.");
  expect(typeof app?.version === "string" && app.version.length > 0, "Repository app should declare version.");
} catch (error) {
  failures.push(`repository/apps.example.json is not valid JSON: ${error.message}`);
}

if (failures.length > 0) {
  console.error("FNOS package verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("FNOS package verification passed.");
