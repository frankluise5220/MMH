#!/usr/bin/env node
// 发布前的镜像层体积门禁。
//
// 国内镜像站（ghcr.dockerproxy.net / ghcr.m.daocloud.io）按**单个 blob** 断线：
// 层下到 100% 后校验失败，然后无限重试同一层。实测 11.48 MB 能过，14.25 / 15.64 /
// 16.21 / 18.76 / 20.18 / 20.74 / 21.13 / 24.31 MB 每次都卡在 Retrying。这不是总大小
// 限制——30 个小层能拉完，一个 20 MB 的层永远拉不完。
//
// 因此「镜像发布成功」不等于「用户能升级」：0.1.81 的执行器是耦合拉取
// （compose pull updater app），任何一个超线层都会让整次升级卡死。
//
// 关键口径：**基础镜像层不算风险**。node:20-bookworm 的 201.75 MB 层、docker:28-cli
// 的 20.74 MB 层在 0.1.81 用户的本地存储里已经存在，按 blob digest 直接跳过。
// 只有「相对存量用户正在跑的版本新增/变更的层」才会被真正下载。所以按绝对体积
// 报红会把 app 镜像永久判红（基础层改不动），门禁必须用 --since 比对差集。
//
// 用法：
//   node scripts/check-image-layer-sizes.mjs --tag 0.1.82 --since 0.1.81   # 发布门禁
//   node scripts/check-image-layer-sizes.mjs --tag 0.1.82                  # 无基线：只报告
//   node scripts/check-image-layer-sizes.mjs --repo mmh-updater --tag latest
//   node scripts/check-image-layer-sizes.mjs --tag 0.1.82 --max-mb 12      # 临时放宽
//
// 退出码 1 表示存在超线的**新增**层，不要发布（或不要把 latest 指向它）。

const OWNER = process.env.MMH_IMAGE_OWNER || "frankluise5220";
const DEFAULT_REPOS = ["mmh", "mmh-updater"];
// 设计目标 ≤ 8 MB；实测断开线在 12.89（过）与 14.25（卡死）之间，取 10 MB 留余量。
const HARD_LIMIT_MB = 10;

function parseArgs(argv) {
  const args = { only: null, tag: "latest", since: null, maxMb: HARD_LIMIT_MB, reportOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--repo") {
      args.only = value;
      i += 1;
    } else if (key === "--tag") {
      args.tag = value;
      i += 1;
    } else if (key === "--since") {
      args.since = value;
      i += 1;
    } else if (key === "--max-mb") {
      args.maxMb = Number(value);
      i += 1;
    } else if (key === "--report-only") {
      args.reportOnly = true;
    }
  }
  return args;
}

async function withRetry(label, task, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      // 刚从 CI push 上去的 manifest 有短暂的可见性延迟，等几秒再问。
      await new Promise((resolve) => setTimeout(resolve, 4000 * attempt));
    }
  }
  throw new Error(`${label} 重试 ${attempts} 次仍失败：${lastError?.message || lastError}`);
}

async function ghcrToken(repo) {
  return withRetry(`获取 GHCR token（${repo}）`, async () => {
    const res = await fetch(
      `https://ghcr.io/token?scope=repository:${repo}:pull&service=ghcr.io`,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (!body?.token) throw new Error("响应里没有 token");
    return body.token;
  });
}

async function fetchManifest(repo, reference, token, accept) {
  return withRetry(`读取 ${repo}:${reference}`, async () => {
    const res = await fetch(`https://ghcr.io/v2/${repo}/manifests/${reference}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: accept.join(","),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    return res.json();
  });
}

async function resolveLayers(name, tag) {
  const repo = `${OWNER}/${name}`;
  const token = await ghcrToken(repo);
  const indexAccept = [
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
  ];
  const manifestAccept = [
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
  ];
  let manifest = await fetchManifest(repo, tag, token, indexAccept);
  let digest = "(single-arch manifest)";
  if (Array.isArray(manifest.manifests)) {
    const amd64 = manifest.manifests.find(
      (entry) => entry?.platform?.architecture === "amd64" && entry?.platform?.os === "linux",
    );
    if (!amd64) throw new Error(`${repo}:${tag} 没有 linux/amd64 的 manifest`);
    digest = amd64.digest;
    manifest = await fetchManifest(repo, digest, token, manifestAccept);
  }
  return { repo, digest, layers: Array.isArray(manifest.layers) ? manifest.layers : [] };
}

function formatMb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2);
}

function summarize(layers) {
  return {
    count: layers.length,
    total: layers.reduce((sum, layer) => sum + layer.size, 0),
    max: layers.reduce((value, layer) => Math.max(value, layer.size), 0),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repos = args.only ? [args.only] : DEFAULT_REPOS;
  const maxBytes = args.maxMb * 1024 * 1024;
  let failed = false;

  for (const name of repos) {
    let result;
    try {
      result = await resolveLayers(name, args.tag);
    } catch (error) {
      console.error(`\n✗ ${name}:${args.tag} 读取失败`);
      console.error(`  ${error.message}`);
      console.error("  发布前必须能从 GHCR 读到 manifest；读不到就不要发布。");
      failed = true;
      continue;
    }

    const { layers } = result;
    const all = summarize(layers);
    console.log(`\n${name}:${args.tag}  (${result.digest.slice(0, 19)}…)`);
    console.log(
      `  全量：layers=${all.count}  total=${formatMb(all.total)} MB  max=${formatMb(all.max)} MB` +
        "（含基础镜像层，存量用户本地已有，不用再下载）",
    );

    let baseline = null;
    if (args.since) {
      try {
        baseline = await resolveLayers(name, args.since);
      } catch (error) {
        console.warn(`  ! 基线 ${name}:${args.since} 读取失败，退化成全量报告：${error.message}`);
      }
    }

    if (!baseline) {
      // 没有基线就没法区分「用户已有的基础层」和「本次新增的层」，只报不判定。
      console.log(`  增量：无基线（${args.since ? `--since ${args.since} 不可用` : "未指定 --since"}），跳过判定`);
      layers
        .map((layer, index) => ({ index: index + 1, size: layer.size, digest: layer.digest }))
        .filter((layer) => layer.size > maxBytes)
        .forEach((layer) => {
          console.log(`  #${String(layer.index).padStart(2, "0")} ${String(formatMb(layer.size)).padStart(8)} MB  ${layer.digest.slice(7, 19)}  （超 ${args.maxMb} MB，未判定）`);
        });
      continue;
    }

    const reused = new Set(baseline.layers.map((layer) => layer.digest));
    const fresh = layers
      .map((layer, index) => ({ index: index + 1, size: layer.size, digest: layer.digest }))
      .filter((layer) => !reused.has(layer.digest));
    const freshSummary = summarize(fresh);
    const keptSummary = summarize(layers.filter((layer) => reused.has(layer.digest)));
    const oversized = fresh.filter((layer) => layer.size > maxBytes);

    console.log(
      `  增量（vs ${args.since}）：${freshSummary.count} 层  ${formatMb(freshSummary.total)} MB  最大 ${formatMb(freshSummary.max)} MB` +
        `；复用 ${keptSummary.count} 层 ${formatMb(keptSummary.total)} MB`,
    );
    for (const layer of [...fresh].sort((a, b) => b.size - a.size)) {
      const flag = layer.size > maxBytes ? "  ✗" : "";
      console.log(
        `  #${String(layer.index).padStart(2, "0")} ${String(formatMb(layer.size)).padStart(8)} MB  ${layer.digest.slice(7, 19)}${flag}`,
      );
    }

    if (oversized.length > 0) {
      failed = true;
      console.error(
        `  ✗ 本次新增/变更层里有 ${oversized.length} 层超过 ${args.maxMb} MB：国内镜像站会下到 100% 后无限重试，存量用户会卡在"拉取镜像"。`,
      );
      console.error("    修法见 Dockerfile / Dockerfile.updater 顶部的层切分说明（单层不许超过 10 MB）。");
    } else if (args.reportOnly) {
      console.log(`  · 报告模式：新增层最大 ${formatMb(freshSummary.max)} MB，不做判定`);
    } else {
      console.log(`  ✓ 新增/变更层均 ≤ ${args.maxMb} MB`);
    }
  }

  if (failed) {
    process.exitCode = 1;
    console.error("\n镜像层体积门禁未通过。");
    return;
  }
  console.log("\n镜像层体积门禁通过。");
}

main().catch((error) => {
  console.error(`镜像层体积检查异常：${error?.stack || error}`);
  process.exitCode = 1;
});
