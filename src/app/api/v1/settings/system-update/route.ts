import { NextRequest, NextResponse } from "next/server";
import { exec, execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

export const runtime = "nodejs";

function getWatchtowerConfig() {
  return {
    url: process.env.WATCHTOWER_API_URL || "http://watchtower:8080",
    token: process.env.WATCHTOWER_HTTP_API_TOKEN || "",
  };
}

type DockerVersionInfo = {
  localCommit: string;
  localCommitMsg: string;
  localCommitDate: string;
  remoteCommit: string;
  remoteCommitMsg: string;
  needsUpdate: boolean;
  canCheckUpdate: boolean;
};

async function getDockerVersionInfo(): Promise<DockerVersionInfo> {
  const localFullCommit = process.env.APP_COMMIT || "";
  const localCommit = localFullCommit ? localFullCommit.slice(0, 7) : "unknown";
  const localCommitMsg = process.env.APP_COMMIT_MESSAGE || (localFullCommit ? "Docker 镜像构建版本" : "当前镜像缺少构建版本信息");
  const localCommitDate = process.env.APP_COMMIT_DATE || "";

  try {
    const response = await fetch("https://api.github.com/repos/frankluise5220/MMH/commits/main", {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "MMH-System-Update" },
      cache: "no-store",
    });

    if (!response.ok) throw new Error(response.statusText);

    const data = await response.json() as {
      sha?: string;
      commit?: { message?: string };
    };
    const remoteFullCommit = data.sha || "";
    const remoteCommit = remoteFullCommit ? remoteFullCommit.slice(0, 7) : "unknown";
    const remoteCommitMsg = data.commit?.message?.split("\n")[0] || "";
    const canCheckUpdate = Boolean(localFullCommit && remoteFullCommit);

    return {
      localCommit,
      localCommitMsg,
      localCommitDate,
      remoteCommit,
      remoteCommitMsg,
      needsUpdate: canCheckUpdate && localFullCommit !== remoteFullCommit,
      canCheckUpdate,
    };
  } catch {
    return {
      localCommit,
      localCommitMsg,
      localCommitDate,
      remoteCommit: "unknown",
      remoteCommitMsg: "",
      needsUpdate: false,
      canCheckUpdate: false,
    };
  }
}

/**
 * 检测当前是否运行在 Docker 容器内
 * Docker 容器内通过 Watchtower HTTP API 触发宿主机更新
 */
function isDockerEnvironment(): boolean {
  // 方法1：检查 /.dockerenv 文件（Docker 官方标记）
  if (existsSync("/.dockerenv")) return true;
  // 方法2：检查 /proc/1/cgroup 是否包含 docker/kubernetes
  try {
    const cgroup = readFileSync("/proc/1/cgroup", "utf-8");
    if (cgroup.includes("docker") || cgroup.includes("kubepods")) return true;
  } catch { /* 文件不存在则忽略 */ }
  // 方法3：环境变量标记
  if (process.env.DOCKER_CONTAINER === "true") return true;
  return false;
}

/**
 * GET /api/v1/settings/system-update
 * 查询当前版本信息和远程是否有新版本
 *
 * Docker 环境下：
 * - 容器内没有 .git 目录，git 命令全部失败
 * - 通过 Watchtower HTTP API 触发宿主机拉取新镜像并重启容器
 */
export async function GET() {
  const dockerMode = isDockerEnvironment();

  try {
    const projectRoot = process.cwd();

    // 当前版本号
    const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf-8"));
    const localVersion = pkg.version || "unknown";

    // Docker 环境下：读取镜像构建提交，并查询 GitHub main 最新提交判断是否可更新
    if (dockerMode) {
      const dockerVersion = await getDockerVersionInfo();
      return NextResponse.json({
        ok: true,
        isDocker: true,
        localVersion,
        ...dockerVersion,
      });
    }

    // 当前 commit
    let localCommit = "";
    let localCommitMsg = "";
    let localCommitDate = "";
    try {
      localCommit = execSync("git rev-parse --short HEAD", { cwd: projectRoot, encoding: "utf-8" }).trim();
      localCommitMsg = execSync("git log -1 --format=%s", { cwd: projectRoot, encoding: "utf-8" }).trim();
      localCommitDate = execSync("git log -1 --format=%ci", { cwd: projectRoot, encoding: "utf-8" }).trim();
    } catch {
      localCommit = "unknown";
    }

    // 远程最新 commit
    let remoteCommit = "";
    let remoteCommitMsg = "";
    let needsUpdate = false;
    try {
      execSync("git fetch origin main", { cwd: projectRoot, encoding: "utf-8", timeout: 15000 });
      remoteCommit = execSync("git rev-parse --short origin/main", { cwd: projectRoot, encoding: "utf-8" }).trim();
      remoteCommitMsg = execSync("git log -1 --format=%s origin/main", { cwd: projectRoot, encoding: "utf-8" }).trim();
      const localFull = execSync("git rev-parse HEAD", { cwd: projectRoot, encoding: "utf-8" }).trim();
      const remoteFull = execSync("git rev-parse origin/main", { cwd: projectRoot, encoding: "utf-8" }).trim();
      needsUpdate = localFull !== remoteFull;
    } catch {
      remoteCommit = "unknown";
    }

    return NextResponse.json({
      ok: true,
      isDocker: false,
      localVersion,
      localCommit,
      localCommitMsg,
      localCommitDate,
      remoteCommit,
      remoteCommitMsg,
      needsUpdate,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "查询失败" }, { status: 500 });
  }
}

/**
 * POST /api/v1/settings/system-update
 * 执行系统更新，使用 SSE 流式推送每个步骤的进度
 *
 * Query params:
 *   mode=update   - 拉取代码 + 安装依赖 + 生成 Prisma + 同步数据库 + 构建（默认）
 *   mode=rebuild  - 仅 安装依赖 + 生成 Prisma + 同步数据库 + 构建（跳过 git pull）
 *
 * Docker 环境下通过 Watchtower HTTP API 触发宿主机容器更新。
 *
 * 非 Docker 环境返回 SSE 流：每个事件格式为 data: {JSON}\n\n
 * 事件类型：
 *   { step: string, status: "running" }
 *   { step: string, status: "completed", output: string }
 *   { step: string, status: "failed", output: string }
 *   { type: "done", ok: boolean, error?: string }
 */
export async function POST(req: NextRequest) {
  if (isDockerEnvironment()) {
    const dockerVersion = await getDockerVersionInfo();
    if (!dockerVersion.canCheckUpdate) {
      return NextResponse.json({
        ok: false,
        error: "无法确认是否有新版本，请先刷新版本信息或重新安装新版镜像后再试。",
      }, { status: 409 });
    }
    if (!dockerVersion.needsUpdate) {
      return NextResponse.json({
        ok: false,
        error: "当前已是最新版本，无需更新。",
      }, { status: 409 });
    }

    const watchtower = getWatchtowerConfig();
    if (!watchtower.token) {
      return NextResponse.json({
        ok: false,
        error: "Docker 环境更新服务未就绪，请重启容器后再试。",
      }, { status: 400 });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    try {
      const response = await fetch(`${watchtower.url}/v1/update`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${watchtower.token}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        return NextResponse.json({
          ok: false,
          error: `触发 Watchtower 更新失败：${text || response.statusText}`,
        }, { status: 500 });
      }
    } catch (e) {
      if (!(e instanceof Error) || e.name !== "AbortError") {
        return NextResponse.json({
          ok: false,
          error: `触发 Watchtower 更新失败：${e instanceof Error ? e.message : "网络错误"}`,
        }, { status: 500 });
      }
    } finally {
      clearTimeout(timeout);
    }

    return NextResponse.json({ ok: true, message: "已触发 Watchtower 更新，容器可能正在重启，请稍后刷新页面。" });
  }

  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("mode") || "update";
  const projectRoot = process.cwd();

  const allSteps: { step: string; cmd: string; timeout: number }[] = [
    { step: "拉取代码", cmd: "git pull origin main", timeout: 60000 },
    { step: "安装依赖", cmd: "npm install", timeout: 120000 },
    { step: "生成 Prisma Client", cmd: "npx prisma generate", timeout: 30000 },
    { step: "同步数据库", cmd: "npx prisma db push", timeout: 30000 },
    { step: "构建项目", cmd: "npm run build", timeout: 180000 },
  ];

  // rebuild 模式跳过 git pull
  const steps = mode === "rebuild" ? allSteps.slice(1) : allSteps;

  const encoder = new TextEncoder();

  function sseEvent(data: Record<string, unknown>) {
    return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
  }

  async function runStep(step: string, cmd: string, timeout: number): Promise<{ ok: boolean; output: string }> {
    return new Promise((resolve) => {
      exec(cmd, { cwd: projectRoot, encoding: "utf-8", timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, output: (stderr?.trim() || err.message) });
        } else {
          resolve({ ok: true, output: (stdout?.trim() || "完成") });
        }
      });
    });
  }

  const stream = new ReadableStream({
    async start(controller) {
      let hasError = false;
      let errorMsg = "";

      for (const s of steps) {
        if (hasError) break;

        // 推送 "running" 状态
        controller.enqueue(sseEvent({ step: s.step, status: "running" }));

        const result = await runStep(s.step, s.cmd, s.timeout);

        if (result.ok) {
          controller.enqueue(sseEvent({ step: s.step, status: "completed", output: result.output }));
        } else {
          controller.enqueue(sseEvent({ step: s.step, status: "failed", output: result.output }));
          hasError = true;
          errorMsg = `${s.step} 失败: ${result.output}`;
        }
      }

      // 最终 done 事件
      controller.enqueue(sseEvent({ type: "done", ok: !hasError, error: errorMsg }));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
