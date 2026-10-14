/**
 * 分诊 + 任务规格撰写。
 *
 * 输入：原始报错条目（GitHub issue / 反馈邮件）
 * 输出：结构化任务规格（复现步骤、疑似文件、验收标准、约束…）
 *
 * 模型走 OpenAI 兼容端点（/chat/completions）。未配置模型或调用失败时
 * 走规则兜底 —— 服务必须能在没有模型的情况下继续产出任务，不能整体挂掉。
 */

import { log } from "./log.mjs";
import { extractJson, truncate, toArray } from "./util.mjs";

/** 所有任务共用的硬约束。用户口径：只改代码，待提交。 */
export const DEFAULT_CONSTRAINTS = [
  "只修改代码，不要执行 git commit / git push / 开 PR —— 改动留在工作区待人工提交。",
  "改动完成后运行 `npx tsc --noEmit` 自检，确保没有新增类型错误。",
  "只改与本任务相关的文件；不要顺手重构、重排或格式化无关代码。",
  "不要改动 package.json 里的依赖版本，不要改 Prisma schema / 数据库迁移（除非任务明确要求）。",
  "遵循仓库既有约定（见 AGENTS.md 的产品方向与数据安全约束）。",
  "无法确定根因或改动风险高时，不要提交半成品；在任务目录写 `BLOCKED.md` 说明卡点与已排除的方向。",
];

const SYSTEM_PROMPT = [
  "你是 MMH 家庭记账系统的资深维护者。MMH 是 Next.js(App Router) + Prisma + TypeScript 项目，",
  "支持 Web 与移动端，多数据库后端（PostgreSQL / SQLite 双引擎）。",
  "你的职责是把用户提交的原始报错，转写成一份给「自动修复 harness」执行的任务规格。",
  "",
  "要求：",
  "1. 先分诊：判断这到底是不是一个真实可修的 bug（还是建议、提问、赞助对账、重复、信息不足）。",
  "2. 只输出一个 JSON 对象，不要任何解释文字、不要 Markdown 围栏。",
  "3. 所有文本用简体中文。",
  "4. 不要编造代码事实：不确定的文件路径就留空数组，不要猜。",
  "5. repro 要写成可操作的步骤；acceptance 要写成可判定的验收项。",
  "",
  "JSON 字段：",
  "{",
  '  "verdict": "bug" | "suggestion" | "question" | "sponsor" | "duplicate" | "unclear",',
  '  "confidence": 0.0-1.0,',
  '  "priority": "high" | "medium" | "low",',
  '  "kind": "bug" | "feature" | "chore",',
  '  "title": "一句话任务标题（不超过 40 字）",',
  '  "summary": "2-4 句：问题是什么、影响什么、大致方向",',
  '  "repro": ["步骤1", "步骤2"],',
  '  "expected": "期望行为",',
  '  "actual": "实际行为",',
  '  "suspected_files": ["src/.../x.ts"],',
  '  "acceptance": ["验收项1", "验收项2"],',
  '  "notes": "给修复者的补充提示（可为空字符串）"',
  "}",
].join("\n");

function buildUserPrompt(item) {
  const parts = [
    `来源: ${item.source === "github" ? "GitHub Issue" : "用户反馈邮件"}`,
    `标识: ${item.externalId}`,
    item.url ? `链接: ${item.url}` : "",
    item.author ? `提交者: ${item.author}` : "",
    `标题: ${item.title}`,
  ];
  const meta = item.meta ?? {};
  if (meta.appVersion) parts.push(`App 版本: ${meta.appVersion}`);
  if (meta.type) parts.push(`反馈类型: ${meta.type}`);
  if (meta.labels?.length) parts.push(`标签: ${meta.labels.join(", ")}`);
  parts.push("", "---- 原始内容 ----", truncate(item.body, 6000));
  if (item.comments?.length) {
    parts.push("", "---- 评论 ----");
    for (const c of item.comments.slice(0, 10)) {
      parts.push(`[${c.author ?? "?"}] ${truncate(c.body, 1200)}`);
    }
  }
  if (item.attachments?.length) {
    parts.push("", `---- 附件 ----`, item.attachments.map((a) => a.filename).join(", "));
  }
  parts.push("", "请输出 JSON。");
  return parts.filter((p) => p !== "").join("\n");
}

async function callModel(cfg, item) {
  const url = `${cfg.ai.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const body = {
    model: cfg.ai.model,
    temperature: 0.2,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(item) },
    ],
  };
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cfg.ai.apiKey ? { authorization: `Bearer ${cfg.ai.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(cfg.ai.timeoutMs),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`model HTTP ${response.status}: ${truncate(detail, 300)}`);
  }
  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content ?? "";
  if (!text) throw new Error("model returned empty content");
  return text;
}

/**
 * 无模型时的分诊判据。
 *
 * 邮件侧最可靠的信号是主题前缀 —— 前缀由 MMH 自己按用户选择写入
 * （见 src/app/api/v1/settings/feedback/route.ts 的 subjectPrefix），
 * 所以「[MMH Feedback]」必然是建议、「[MMH Sponsor Tip]」必然是赞助对账，
 * 不需要模型就能正确过滤掉，避免污染修复队列。
 */
export function verdictFromTitle(title, source) {
  const s = String(title ?? "");
  if (/^\[MMH Bug\]/i.test(s)) return "bug";
  if (/^\[MMH Sponsor Tip\]/i.test(s)) return "sponsor";
  if (/^\[MMH Feedback\]/i.test(s)) return "suggestion";
  if (source === "github") return "bug";
  return "unclear";
}

/** 规则兜底：不调模型也能产出可用任务。 */
function fallbackSpec(item, reason) {
  const verdict = verdictFromTitle(item.title, item.source);
  const isBug = verdict === "bug";
  return {
    verdict,
    confidence: 0.2,
    priority: "medium",
    kind: isBug ? "bug" : verdict === "suggestion" ? "feature" : "chore",
    title: item.title.replace(/^\[[^\]]+\]\s*/, "").slice(0, 40) || `处理 ${item.externalId}`,
    summary: `未能调用模型（${reason}）。以下为原始报错内容，需人工先确认问题范围再修复。`,
    repro: [],
    expected: "",
    actual: "",
    suspectedFiles: [],
    acceptance: ["定位根因并修复", "修复后不引入回归"],
    constraints: DEFAULT_CONSTRAINTS,
    notes: "",
    model: "(fallback)",
    triageSource: "fallback",
  };
}

function normalizeSpec(raw, item) {
  const verdict = String(raw.verdict ?? "unclear").toLowerCase();
  const allowedVerdicts = new Set(["bug", "suggestion", "question", "sponsor", "duplicate", "unclear"]);
  const priority = ["high", "medium", "low"].includes(raw.priority) ? raw.priority : "medium";
  const kind = ["bug", "feature", "chore"].includes(raw.kind) ? raw.kind : verdict === "bug" ? "bug" : "chore";
  return {
    verdict: allowedVerdicts.has(verdict) ? verdict : "unclear",
    confidence: Number.isFinite(Number(raw.confidence)) ? Math.max(0, Math.min(1, Number(raw.confidence))) : 0.5,
    priority,
    kind,
    title: String(raw.title ?? item.title).slice(0, 120),
    summary: String(raw.summary ?? "").trim(),
    repro: toArray(raw.repro),
    expected: String(raw.expected ?? "").trim(),
    actual: String(raw.actual ?? "").trim(),
    suspectedFiles: toArray(raw.suspected_files ?? raw.suspectedFiles),
    acceptance: toArray(raw.acceptance),
    constraints: DEFAULT_CONSTRAINTS,
    notes: String(raw.notes ?? "").trim(),
    model: item.model ?? "",
    triageSource: "model",
  };
}

/**
 * 对一个条目做分诊并生成任务规格。
 * 永不抛错：模型失败自动降级为 fallback。
 */
export async function triageItem(cfg, item) {
  if (!cfg.ai.baseUrl || !cfg.ai.model) {
    log.warn(`未配置模型（AI_BASE_URL / AI_MODEL），对 ${item.externalId} 使用规则兜底`);
    return fallbackSpec(item, "未配置模型");
  }
  try {
    const text = await callModel(cfg, item);
    const parsed = extractJson(text);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("模型回复不是合法 JSON");
    }
    const spec = normalizeSpec(parsed, item);
    spec.model = cfg.ai.model;
    return spec;
  } catch (error) {
    log.warn(`模型调用失败（${item.externalId}）：${error.message} → 规则兜底`);
    return fallbackSpec(item, error.message);
  }
}
