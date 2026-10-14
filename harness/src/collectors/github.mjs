/**
 * GitHub 采集器：轮询 MMH 仓库的 open issue。
 *
 * 去重口径：`number@updated_at` —— issue 正文被编辑或新增评论后 updated_at 变化，
 * 会作为「新修订」重新入队（这符合「检测器」语义：有新活动就该重新评估）。
 */

import { log } from "../log.mjs";
import { truncate } from "../util.mjs";

function headers(cfg) {
  const h = {
    accept: "application/vnd.github+json",
    "user-agent": "mmh-bug-harness",
    "x-github-api-version": "2022-11-28",
  };
  if (cfg.github.token) h.authorization = `Bearer ${cfg.github.token}`;
  return h;
}

async function ghFetch(cfg, url) {
  const response = await fetch(url, { headers: headers(cfg), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (!cfg.github.token && (response.status === 403 || response.status === 429)) {
      throw new Error(
        `GitHub 匿名额度用尽（HTTP ${response.status}）—— 公开仓库匿名限 60 次/小时，` +
          `请调大轮询间隔或配置 GITHUB_TOKEN。原始响应：${truncate(detail, 160)}`,
      );
    }
    throw new Error(`GitHub HTTP ${response.status} ${url}: ${truncate(detail, 200)}`);
  }
  return response.json();
}

async function fetchOpenIssues(cfg) {
  const params = new URLSearchParams({
    state: "open",
    per_page: "100",
    sort: "updated",
    direction: "desc",
  });
  if (cfg.github.labels.length) params.set("labels", cfg.github.labels.join(","));
  const url = `${cfg.github.apiBase}/repos/${cfg.github.repo}/issues?${params.toString()}`;
  const list = await ghFetch(cfg, url);
  if (!Array.isArray(list)) throw new Error("GitHub 返回的不是 issue 数组");
  // issues 接口会混入 PR，用 pull_request 字段剔除。
  return list.filter((it) => !it.pull_request);
}

async function fetchComments(cfg, issueNumber) {
  if (cfg.github.commentsMax <= 0) return [];
  const url = `${cfg.github.apiBase}/repos/${cfg.github.repo}/issues/${issueNumber}/comments?per_page=${cfg.github.commentsMax}`;
  try {
    const list = await ghFetch(cfg, url);
    if (!Array.isArray(list)) return [];
    return list.slice(-cfg.github.commentsMax).map((c) => ({
      author: c.user?.login ?? "?",
      body: truncate(c.body ?? "", 2000),
      createdAt: c.created_at,
    }));
  } catch (error) {
    log.warn(`抓取 issue #${issueNumber} 评论失败：${error.message}`);
    return [];
  }
}

function renderIssueBody(issue) {
  const lines = [issue.body?.trim() || "（issue 正文为空）"];
  return lines.join("\n");
}

/**
 * 拉取一轮 GitHub。返回待处理条目数组（已剔除处理过的修订）。
 * @param {object} cfg
 * @param {import('../store.mjs').Store} store
 */
export async function collectGithub(cfg, store) {
  // 公开仓库可以匿名读；私有仓库必须配 PAT，否则下面的请求会以 404/403 失败并记进日志。
  if (!cfg.github.token) {
    log.warn("未配置 GITHUB_TOKEN，以匿名方式读取（限 60 次/小时，仅适用于公开仓库）");
  }

  // firstRun=now 且从未轮询过：把当前时间记为基线，不回补历史 issue。
  if (cfg.firstRun === "now" && !store.state.lastGithubPollAt) {
    store.state.lastGithubPollAt = new Date().toISOString();
    store.markDirty();
    log.info("HARNESS_FIRST_RUN=now：跳过既有 open issue，只监听后续活动");
    return [];
  }

  let issues;
  try {
    issues = await fetchOpenIssues(cfg);
  } catch (error) {
    log.error(`GitHub 采集失败：${error.message}`);
    return [];
  }

  const items = [];
  for (const issue of issues) {
    const processKey = `github:${issue.number}@${issue.updated_at}`;
    if (store.isProcessed(processKey)) continue;
    if (store.findTaskBySource("github", String(issue.number)) && store.isProcessed(`github:${issue.number}@${issue.updated_at}`)) {
      continue;
    }
    const comments = await fetchComments(cfg, issue.number);
    items.push({
      source: "github",
      externalId: String(issue.number),
      taskId: `GH-${issue.number}`,
      processKey,
      title: issue.title ?? `Issue #${issue.number}`,
      body: renderIssueBody(issue),
      url: issue.html_url,
      author: issue.user?.login ?? "",
      meta: {
        labels: (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean),
        state: issue.state,
        createdAt: issue.created_at,
        updatedAt: issue.updated_at,
      },
      comments,
      attachments: [],
    });
  }

  store.state.lastGithubPollAt = new Date().toISOString();
  store.markDirty();
  log.info(`GitHub 采集完成：${issues.length} 个 open issue，${items.length} 个待处理修订`);
  return items;
}
