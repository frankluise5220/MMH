import { NextResponse } from "next/server";
import { spawn, exec } from "child_process";

const PORT = 49152;
let studioProcess: ReturnType<typeof spawn> | null = null;

function startStudio(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (studioProcess) {
      // Already running, check if actually alive
      if (studioProcess.exitCode === null) {
        resolve();
        return;
      }
      studioProcess = null;
    }

    const proc = spawn("npx", ["prisma", "studio", "--port", String(PORT), "--browser", "none"], {
      cwd: process.cwd(),
      shell: true,
      stdio: "pipe",
    });

    proc.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      // Prisma Studio outputs when ready
      if (text.includes("localhost") || text.includes("127.0.0.1") || text.includes(String(PORT))) {
        studioProcess = proc;
        resolve();
      }
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      if (text.includes("localhost") || text.includes("127.0.0.1") || text.includes(String(PORT))) {
        studioProcess = proc;
        resolve();
      }
    });

    proc.on("error", (err) => {
      studioProcess = null;
      reject(err);
    });

    proc.on("exit", () => {
      studioProcess = null;
    });

    // Timeout after 10 seconds
    setTimeout(() => {
      // If process is still running, assume it started
      if (proc.exitCode === null) {
        studioProcess = proc;
        resolve();
      }
    }, 10000);
  });
}

function stopStudio(): Promise<void> {
  return new Promise((resolve) => {
    if (!studioProcess) {
      // Try to kill by port
      exec(`npx kill-port ${PORT}`, { cwd: process.cwd() }, () => {
        resolve();
      });
      return;
    }

    studioProcess.on("exit", () => {
      studioProcess = null;
      resolve();
    });

    studioProcess.kill("SIGTERM");

    // Force kill after 3 seconds
    setTimeout(() => {
      if (studioProcess && studioProcess.exitCode === null) {
        studioProcess.kill("SIGKILL");
      }
    }, 3000);

    // Resolve anyway after 5 seconds
    setTimeout(() => resolve(), 5000);
  });
}

// POST: 启动 Prisma Studio
export async function POST() {
  try {
    await startStudio();
    return NextResponse.json({ ok: true, port: PORT });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "启动失败" }, { status: 500 });
  }
}

// DELETE: 停止 Prisma Studio
export async function DELETE() {
  try {
    await stopStudio();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "停止失败" }, { status: 500 });
  }
}