/**
 * 连接自测：在页面上点「测试连接」时调用。
 *
 * 这是 .env 时代最缺的能力 —— 密钥填错了只能等轮询日志报错，
 * 而且不同失败原因（token 无效 / 权限不足 / 仓库不存在 / IMAP 授权码过期）
 * 在日志里长得差不多。这里逐个把可区分的失败原因说清楚。
 */

import { ImapFlow } from "imapflow";

function timeout(ms) {
  return AbortSignal.timeout(ms);
}

async function readError(response) {
  const text = await response.text().catch(() => "");
  try {
    const data = JSON.parse(text);
    return data.message || data.error?.message || data.error || text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

/**
 * GitHub：先验身份（有 token 时），再验仓库可读，最后验 Issues 可读。
 * 公开仓库允许匿名验证，此时跳过 /user 并提示匿名额度限制。
 */
export async function testGithub(cfg) {
  const { token, repo, apiBase } = cfg.github;
  if (!repo || !repo.includes("/")) return { ok: false, message: "仓库应写成 owner/name 形式" };

  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "mmh-bug-harness",
    "x-github-api-version": "2022-11-28",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const base = apiBase.replace(/\/+$/, "");

  try {
    let identity = "匿名（未配置 PAT）";
    if (token) {
      const me = await fetch(`${base}/user`, { headers, signal: timeout(15000) });
      if (me.status === 401) return { ok: false, message: "令牌无效或已过期（401）" };
      if (!me.ok) return { ok: false, message: `校验身份失败：HTTP ${me.status} ${await readError(me)}` };
      identity = (await me.json()).login;
    }

    const repoRes = await fetch(`${base}/repos/${repo}`, { headers, signal: timeout(15000) });
    if (repoRes.status === 404) {
      return {
        ok: false,
        message: token
          ? `令牌看不到仓库 ${repo}（404）—— 检查 PAT 的仓库范围是否包含它`
          : `仓库 ${repo} 不存在或非公开（404）—— 私有仓库必须配置 PAT`,
      };
    }
    if (!repoRes.ok) return { ok: false, message: `读取仓库失败：HTTP ${repoRes.status} ${await readError(repoRes)}` };
    const repoData = await repoRes.json();

    const issuesRes = await fetch(`${base}/repos/${repo}/issues?state=open&per_page=1`, {
      headers,
      signal: timeout(15000),
    });
    if (issuesRes.status === 403 || issuesRes.status === 429) {
      return {
        ok: false,
        message: token
          ? `被 GitHub 拒绝（HTTP ${issuesRes.status}）：${await readError(issuesRes)}`
          : `匿名额度已用尽（HTTP ${issuesRes.status}）—— 匿名限 60 次/小时，请配置 PAT 或调大轮询间隔`,
      };
    }
    if (!issuesRes.ok) {
      return {
        ok: false,
        message: `仓库可读但 Issues 不可读（HTTP ${issuesRes.status}）—— PAT 需要 Issues: Read 权限`,
      };
    }
    const issues = await issuesRes.json();
    const sample = Array.isArray(issues) && issues[0] ? `#${issues[0].number} ${issues[0].title}` : "（无 open issue）";

    const detail = [
      `身份：${identity}`,
      `仓库：${repoData.full_name}（${repoData.private ? "私有" : "公开"}）`,
      `默认分支：${repoData.default_branch}`,
      `最新 open issue：${sample}`,
    ];
    if (!token) detail.push("未配置 PAT：匿名限 60 次/小时，建议轮询间隔 ≥ 10 分钟");

    return {
      ok: true,
      message: token ? `已以 ${identity} 身份连接，仓库可读，Issues 可读` : "匿名连接成功，公开仓库可读",
      detail,
    };
  } catch (error) {
    return { ok: false, message: `网络或超时：${error.message}` };
  }
}

/** IMAP：真实登录 + 打开目标文件夹 + 统计未读，并按主题前缀预估会被采集的封数。 */
export async function testImap(cfg) {
  const { host, port, secure, user, pass, mailbox, subjectFilter } = cfg.imap;
  if (!host || !user || !pass) return { ok: false, message: "主机 / 账号 / 授权码未填齐" };

  const client = new ImapFlow({
    host,
    port,
    secure,
    auth: { user, pass },
    logger: false,
    socketTimeout: 20000,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock(mailbox);
    try {
      const box = client.mailbox;
      let matched = 0;
      let scanned = 0;
      if (subjectFilter.length) {
        for await (const msg of client.fetch({ seen: false }, { uid: true, envelope: true })) {
          scanned += 1;
          if (scanned > 200) break;
          const subject = msg.envelope?.subject ?? "";
          if (subjectFilter.some((p) => subject.toLowerCase().includes(p.toLowerCase()))) matched += 1;
        }
      }

      const detail = [
        `文件夹：${mailbox}（共 ${box.exists} 封）`,
        `未读：${box.unseen ?? "未知"} 封`,
      ];
      if (subjectFilter.length) {
        detail.push(`前 200 封未读中，主题命中「${subjectFilter.join(" / ")}」的：${matched} 封`);
      } else {
        detail.push("主题过滤已关闭（*），所有未读邮件都会被采集");
      }
      return { ok: true, message: `已登录 ${user}@${host}`, detail };
    } finally {
      lock.release();
    }
  } catch (error) {
    const message = String(error.message ?? error);
    if (/auth|credential|login|AUTHENTICATIONFAILED/i.test(message)) {
      return { ok: false, message: `认证失败：授权码不正确或未开启 IMAP（${message}）` };
    }
    if (/ENOTFOUND|getaddrinfo|ETIMEDOUT|ECONNREFUSED/i.test(message)) {
      return { ok: false, message: `连不上 ${host}:${port} —— 检查主机名、端口与网络（${message}）` };
    }
    return { ok: false, message };
  } finally {
    try {
      await client.logout();
    } catch {
      /* ignore */
    }
  }
}

/** 模型：优先列 /models；端点不支持时退化为一次最小 chat 调用。 */
export async function testAi(cfg) {
  const { baseUrl, apiKey, model, timeoutMs } = cfg.ai;
  if (!baseUrl) return { ok: false, message: "未配置接口地址" };
  if (!model) return { ok: false, message: "未配置模型名" };

  const base = baseUrl.replace(/\/+$/, "");
  const headers = { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };

  try {
    const modelsRes = await fetch(`${base}/models`, {
      headers: { accept: "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      signal: timeout(15000),
    });
    if (modelsRes.ok) {
      const data = await modelsRes.json().catch(() => null);
      const ids = Array.isArray(data?.data) ? data.data.map((m) => m.id) : [];
      const hit = ids.includes(model);
      return {
        ok: true,
        message: hit ? `端点可达，模型 ${model} 在列表中` : `端点可达，但模型列表里没有 ${model}`,
        detail: [
          `接口：${base}`,
          `可用模型数：${ids.length}`,
          hit ? `已确认 ${model} 存在` : `列表前 10 个：${ids.slice(0, 10).join(", ") || "（空）"}`,
        ],
      };
    }
    // 有些网关不实现 /models，直接打一次最小补全
    const chatRes = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: "user", content: "ping" }] }),
      signal: timeout(timeoutMs || 30000),
    });
    if (chatRes.status === 401 || chatRes.status === 403) {
      return { ok: false, message: `鉴权失败（HTTP ${chatRes.status}）：${await readError(chatRes)}` };
    }
    if (!chatRes.ok) {
      return { ok: false, message: `补全请求失败（HTTP ${chatRes.status}）：${await readError(chatRes)}` };
    }
    const data = await chatRes.json();
    const content = data?.choices?.[0]?.message?.content ?? "";
    return {
      ok: true,
      message: `补全调用成功（/models 不可用，已用最小请求验证）`,
      detail: [`接口：${base}`, `模型：${model}`, `回复：${String(content).slice(0, 60) || "（空）"}`],
    };
  } catch (error) {
    return { ok: false, message: `网络或超时：${error.message}` };
  }
}

export const TESTERS = {
  github: { label: "GitHub", run: testGithub },
  imap: { label: "反馈邮箱", run: testImap },
  ai: { label: "模型", run: testAi },
};
