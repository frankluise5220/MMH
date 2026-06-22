/**
 * 系统更新接口。
 *
 * GET: 返回当前 Git 版本、远端版本、是否需要更新。
 * POST ?mode=update: 执行 git fetch + fast-forward merge，然后安装依赖、生成 Prisma、同步数据库、构建。
 * POST ?mode=rebuild: 不拉取代码，只重新安装依赖、生成 Prisma、同步数据库、构建。
 *
 * 返回格式：
 * - GET: { ok, isDocker, updateMode, localVersion, localCommit, localCommitMsg, localCommitDate, remoteCommit, remoteCommitMsg, needsUpdate, canCheckUpdate }
 * - POST: text/event-stream，每条 data 为 { step, status, output? }，结束为 { type: "done", ok, error?, restartRequired }
 */
import { NextRequest, NextResponse } from "next/server";
import { exec, execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

export const runtime = "nodejs";

type VersionInfo = {
  localCommit: string;
  localCommitMsg: string;
  localCommitDate: string;
  remoteCommit: string;
  remoteCommitMsg: string;
  needsUpdate: boolean;
  canCheckUpdate: boolean;
};

let updateRunning = false;

function isDockerEnvironment(): boolean {
  if (existsSync("/.dockerenv")) return true;
  try {
    const cgroup = readFileSync("/proc/1/cgroup", "utf-8");
    if (cgroup.includes("docker") || cgroup.includes("kubepods")) return true;
  } catch {
    // /proc is unavailable on non-Linux hosts.
  }
  return process.env.DOCKER_CONTAINER === "true";
}

function safeGitName(value: string | undefined, fallback: string) {
  const v = String(value ?? "").trim();
  if (!v || v.startsWith("-")) return fallback;
  return /^[A-Za-z0-9._/-]+$/.test(v) ? v : fallback;
}

function getGitTarget() {
  const remote = safeGitName(process.env.MMH_GIT_REMOTE, "origin");
  const branch = safeGitName(process.env.MMH_GIT_BRANCH, "main");
  return { remote, branch, ref: `${remote}/${branch}` };
}

function getLocalGitInfo(projectRoot: string) {
  try {
    return {
      localCommit: execSync("git rev-parse --short HEAD", { cwd: projectRoot, encoding: "utf-8" }).trim(),
      localCommitMsg: execSync("git log -1 --format=%s", { cwd: projectRoot, encoding: "utf-8" }).trim(),
      localCommitDate: execSync("git log -1 --format=%ci", { cwd: projectRoot, encoding: "utf-8" }).trim(),
    };
  } catch {
    return { localCommit: "unknown", localCommitMsg: "", localCommitDate: "" };
  }
}

function getGitVersionInfo(projectRoot: string): VersionInfo {
  const { remote, branch, ref } = getGitTarget();
  const local = getLocalGitInfo(projectRoot);

  try {
    execSync(`git fetch ${remote} ${branch}`, { cwd: projectRoot, encoding: "utf-8", timeout: 15000 });
    const remoteCommit = execSync(`git rev-parse --short ${ref}`, { cwd: projectRoot, encoding: "utf-8" }).trim();
    const remoteCommitMsg = execSync(`git log -1 --format=%s ${ref}`, { cwd: projectRoot, encoding: "utf-8" }).trim();
    const localFull = execSync("git rev-parse HEAD", { cwd: projectRoot, encoding: "utf-8" }).trim();
    const remoteFull = execSync(`git rev-parse ${ref}`, { cwd: projectRoot, encoding: "utf-8" }).trim();

    return {
      ...local,
      remoteCommit,
      remoteCommitMsg,
      needsUpdate: localFull !== remoteFull,
      canCheckUpdate: true,
    };
  } catch {
    return {
      ...local,
      remoteCommit: "unknown",
      remoteCommitMsg: "",
      needsUpdate: false,
      canCheckUpdate: false,
    };
  }
}

export async function GET() {
  try {
    const projectRoot = process.cwd();
    const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf-8"));
    const localVersion = pkg.version || "unknown";

    return NextResponse.json({
      ok: true,
      isDocker: isDockerEnvironment(),
      updateMode: "git",
      localVersion,
      ...getGitVersionInfo(projectRoot),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "查询失败" }, { status: 500 });
  }
}

function sseEvent(encoder: TextEncoder, data: Record<string, unknown>) {
  return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

function runStep(projectRoot: string, cmd: string, timeout: number): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    exec(cmd, { cwd: projectRoot, encoding: "utf-8", timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, output: stderr?.trim() || err.message });
      else resolve({ ok: true, output: stdout?.trim() || "完成" });
    });
  });
}

export async function POST(req: NextRequest) {
  if (updateRunning) {
    return NextResponse.json({ ok: false, error: "系统更新正在执行，请稍后再试" }, { status: 409 });
  }

  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("mode") === "rebuild" ? "rebuild" : "update";
  const projectRoot = process.cwd();
  const dockerMode = isDockerEnvironment();
  const { remote, branch, ref } = getGitTarget();

  const allSteps: { step: string; cmd: string; timeout: number }[] = [
    { step: "拉取代码", cmd: `git fetch ${remote} ${branch} && git merge --ff-only ${ref}`, timeout: 60000 },
    { step: "安装依赖", cmd: "npm install --include=dev", timeout: 120000 },
    { step: "生成 Prisma Client", cmd: "npx prisma generate", timeout: 30000 },
    { step: "同步数据库", cmd: "npx prisma db push", timeout: 30000 },
    { step: "构建项目", cmd: "npm run build", timeout: 180000 },
  ];
  const steps = mode === "rebuild" ? allSteps.slice(1) : allSteps;
  const encoder = new TextEncoder();

  updateRunning = true;
  const stream = new ReadableStream({
    async start(controller) {
      let hasError = false;
      let errorMsg = "";

      try {
        for (const s of steps) {
          if (hasError) break;
          controller.enqueue(sseEvent(encoder, { step: s.step, status: "running" }));
          const result = await runStep(projectRoot, s.cmd, s.timeout);
          if (result.ok) {
            controller.enqueue(sseEvent(encoder, { step: s.step, status: "completed", output: result.output }));
          } else {
            controller.enqueue(sseEvent(encoder, { step: s.step, status: "failed", output: result.output }));
            hasError = true;
            errorMsg = `${s.step} 失败: ${result.output}`;
          }
        }

        controller.enqueue(sseEvent(encoder, { type: "done", ok: !hasError, error: errorMsg, restartRequired: dockerMode && !hasError }));
        controller.close();

        if (dockerMode && !hasError) {
          setTimeout(() => process.exit(0), 1500);
        }
      } finally {
        updateRunning = false;
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
