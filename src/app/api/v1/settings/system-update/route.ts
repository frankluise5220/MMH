import { NextRequest, NextResponse } from "next/server";
import { exec, execSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

export const runtime = "nodejs";

/**
 * GET /api/v1/settings/system-update
 * 查询当前版本信息和远程是否有新版本
 */
export async function GET() {
  try {
    const projectRoot = process.cwd();

    // 当前版本号
    const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf-8"));
    const localVersion = pkg.version || "unknown";

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
 * 返回 SSE 流：每个事件格式为 data: {JSON}\n\n
 * 事件类型：
 *   { step: string, status: "running" }
 *   { step: string, status: "completed", output: string }
 *   { step: string, status: "failed", output: string }
 *   { type: "done", ok: boolean, error?: string }
 */
export async function POST(req: NextRequest) {
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
