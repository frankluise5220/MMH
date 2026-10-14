/**
 * 配置模式（单一事实源）。
 *
 * 一处定义，三处消费：
 *   1. config.mjs 按 env 键做分层解析（config.json > 环境变量 > .env > 默认值）
 *   2. 配置页据此自动渲染表单、分组、提示与「来源」标注
 *   3. 保存时据此校验类型
 *
 * 字段类型：
 *   text     单行文本
 *   password 密钥（不回传浏览器，只回 masked + isSet）
 *   number   数字（带 min/max）
 *   boolean  开关
 *   select   下拉（options 为 {value,label}）
 *   list     逗号分隔列表（存字符串，解析成数组）
 */

/** 初始密码。开箱即用，用户登录后应在配置页改成自己的。 */
export const DEFAULT_UI_PASSWORD = "mmh12345";

/** 把密码显式设成这个值 = 关闭登录（仅建议在端口只绑 127.0.0.1 时使用）。 */
export const AUTH_DISABLED_SENTINEL = "-";

export const CONFIG_GROUPS = [
  {
    id: "access",
    title: "访问控制",
    description: "页面登录",
    fields: [
      {
        env: "HARNESS_UI_PASSWORD",
        path: "ui.password",
        label: "页面访问密码",
        type: "password",
        default: DEFAULT_UI_PASSWORD,
        hint:
          `初始密码 ${DEFAULT_UI_PASSWORD}，登录后请在这里改成自己的。` +
          `改密码后所有已登录的浏览器会被立即登出（会话令牌由密码派生）。` +
          `填 ${AUTH_DISABLED_SENTINEL} = 关闭登录，仅建议在端口只绑 127.0.0.1 时使用；` +
          `端口开放到局域网时务必保留密码。`,
      },
    ],
  },
  {
    id: "runtime",
    title: "运行参数",
    description: "轮询节奏与产出行为",
    fields: [
      {
        env: "HARNESS_PORT",
        path: "port",
        label: "状态页端口",
        type: "number",
        default: 7788,
        min: 1,
        max: 65535,
        needsRestart: true,
        hint: "容器内监听端口；改动需重启容器，并同步改 docker-compose.yml 的端口映射",
      },
      {
        env: "HARNESS_POLL_INTERVAL_MS",
        path: "pollIntervalMs",
        label: "轮询间隔（毫秒）",
        type: "number",
        default: 300000,
        min: 30000,
        hint: "默认 300000 = 5 分钟。保存后立即生效（无需重启）",
      },
      {
        env: "HARNESS_FIRST_RUN",
        path: "firstRun",
        label: "首次运行策略",
        type: "select",
        default: "backfill",
        options: [
          { value: "backfill", label: "backfill —— 把现存 open issue / 未读邮件全部生成任务" },
          { value: "now", label: "now —— 只监听服务启动之后的新活动" },
        ],
        hint: "仅在「从未轮询过」时起作用；轮询过一次后由状态库接管",
      },
      {
        env: "HARNESS_DRY_RUN",
        path: "dryRun",
        label: "演练模式",
        type: "boolean",
        default: false,
        hint: "只打印将要生成的任务，不写文件、不改状态库",
      },
      {
        env: "HARNESS_LOG_LEVEL",
        path: "logLevel",
        label: "日志级别",
        type: "select",
        default: "info",
        options: [
          { value: "debug", label: "debug" },
          { value: "info", label: "info" },
          { value: "warn", label: "warn" },
          { value: "error", label: "error" },
        ],
      },
      {
        env: "HARNESS_WORKSPACE_HINT",
        path: "workspaceHint",
        label: "工作区提示",
        type: "text",
        default: "",
        hint: "写进任务 front-matter，告诉第三方 harness 该在哪份 MMH 检出上改代码（如 /volume1/mmh-worktree）",
      },
    ],
  },
  {
    id: "github",
    title: "GitHub",
    description: "issue 采集",
    fields: [
      {
        env: "GITHUB_TOKEN",
        path: "github.token",
        label: "访问令牌（PAT）",
        type: "password",
        default: "",
        hint: "细粒度 PAT，至少需要仓库的 Issues: Read。公开仓库可留空（匿名限 60 次/小时）；私有仓库必填",
      },
      {
        env: "GITHUB_REPO",
        path: "github.repo",
        label: "仓库",
        type: "text",
        default: "frankluise5220/MMH",
      },
      {
        env: "GITHUB_API_BASE",
        path: "github.apiBase",
        label: "API 地址",
        type: "text",
        default: "https://api.github.com",
        hint: "自建 GitHub 企业版才需要改",
      },
      {
        env: "GITHUB_LABELS",
        path: "github.labels",
        label: "只处理带这些标签的 issue",
        type: "list",
        default: "",
        hint: "逗号分隔，如 bug,ui。留空 = 全部 open issue",
      },
      {
        env: "GITHUB_COMMENTS_MAX",
        path: "github.commentsMax",
        label: "抓取评论条数",
        type: "number",
        default: 10,
        min: 0,
        max: 100,
        hint: "每个 issue 抓最近 N 条评论作为上下文",
      },
    ],
  },
  {
    id: "imap",
    title: "反馈邮箱（IMAP）",
    description: "MMH 反馈邮件采集",
    fields: [
      { env: "IMAP_HOST", path: "imap.host", label: "IMAP 主机", type: "text", default: "", hint: "如 imap.exmail.qq.com" },
      { env: "IMAP_PORT", path: "imap.port", label: "端口", type: "number", default: 993, min: 1, max: 65535 },
      { env: "IMAP_SECURE", path: "imap.secure", label: "使用 TLS", type: "boolean", default: true },
      { env: "IMAP_USER", path: "imap.user", label: "账号", type: "text", default: "", hint: "如 mmh@floatingice.win" },
      { env: "IMAP_PASS", path: "imap.pass", label: "授权码", type: "password", default: "", hint: "邮箱的 IMAP 授权码，不是登录密码" },
      { env: "IMAP_MAILBOX", path: "imap.mailbox", label: "邮箱文件夹", type: "text", default: "INBOX" },
      {
        env: "IMAP_SUBJECT_FILTER",
        path: "imap.subjectFilter",
        label: "主题前缀过滤",
        type: "list",
        default: "[MMH Bug]",
        hint: "逗号分隔。MMH 反馈邮件前缀：[MMH Bug] / [MMH Feedback] / [MMH Sponsor Tip]。写 * 表示不过滤",
      },
      {
        env: "IMAP_MARK_SEEN",
        path: "imap.markSeen",
        label: "处理后标记已读",
        type: "boolean",
        default: true,
        hint: "关闭则每轮重扫未读（靠 Message-ID 去重，但会反复解析）",
      },
    ],
  },
  {
    id: "ai",
    title: "模型（OpenAI 兼容）",
    description: "分诊与任务规格撰写",
    fields: [
      {
        env: "AI_BASE_URL",
        path: "ai.baseUrl",
        label: "接口地址",
        type: "text",
        default: "",
        hint: "到 /v1 为止，如 https://api.deepseek.com/v1",
      },
      { env: "AI_API_KEY", path: "ai.apiKey", label: "API Key", type: "password", default: "" },
      { env: "AI_MODEL", path: "ai.model", label: "模型名", type: "text", default: "", hint: "如 deepseek-chat" },
      { env: "AI_TIMEOUT_MS", path: "ai.timeoutMs", label: "超时（毫秒）", type: "number", default: 120000, min: 5000 },
      {
        env: "AI_MAX_CALLS_PER_CYCLE",
        path: "ai.maxCallsPerCycle",
        label: "每轮最多调用次数",
        type: "number",
        default: 10,
        min: 1,
        hint: "防止首次 backfill 一次性打爆额度",
      },
    ],
  },
];

/** 展平所有字段，附上分组 id。 */
export function allFields() {
  const out = [];
  for (const group of CONFIG_GROUPS) {
    for (const field of group.fields) out.push({ ...field, group: group.id });
  }
  return out;
}

/** 按 env 键索引。 */
export function fieldByEnv() {
  const map = new Map();
  for (const field of allFields()) map.set(field.env, field);
  return map;
}

/**
 * 把原始字符串解析成对应类型的值。
 * 注意：`list` 类型返回数组，特殊值 `*` 对 imap.subjectFilter 表示「不过滤」。
 */
export function coerce(field, raw) {
  const value = raw === undefined || raw === null ? "" : String(raw);
  switch (field.type) {
    case "number": {
      const n = Number.parseInt(value, 10);
      return Number.isFinite(n) ? n : Number(field.default ?? 0);
    }
    case "boolean":
      return ["1", "true", "yes", "on"].includes(value.toLowerCase());
    case "list": {
      if (value.trim() === "*") return [];
      return value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    default:
      return value;
  }
}

/** 校验单个字段的输入，返回错误信息或 null。 */
export function validate(field, raw) {
  const value = raw === undefined || raw === null ? "" : String(raw);
  if (field.type === "number") {
    if (value === "") return null;
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n)) return `${field.label} 必须是数字`;
    if (field.min !== undefined && n < field.min) return `${field.label} 不能小于 ${field.min}`;
    if (field.max !== undefined && n > field.max) return `${field.label} 不能大于 ${field.max}`;
  }
  if (field.type === "select" && value !== "") {
    const allowed = (field.options ?? []).map((o) => o.value);
    if (!allowed.includes(value)) return `${field.label} 取值非法`;
  }
  return null;
}

/** 密钥脱敏：只留末 4 位。 */
export function maskSecret(value) {
  const s = String(value ?? "");
  if (!s) return "";
  if (s.length <= 4) return "•".repeat(s.length);
  return `${"•".repeat(Math.min(12, s.length - 4))}${s.slice(-4)}`;
}
