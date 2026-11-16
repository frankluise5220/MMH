/**
 * 通知栏的「有新版本」检查接口。
 *
 * 为什么单独一条路由，而不是让通知栏直接打 GET /api/v1/settings/system-update：
 * 那个接口只给管理员，而且为了设置页要读 Release 正文、更新器镜像源清单、GitHub
 * 兜底，成本远高于「有没有新版本」这一件事。这里只做一次最小判定（Docker 比对
 * 镜像 digest，其余形态比对 GitHub Release 版本号），结果在服务端缓存，可以被
 * 侧边栏低频轮询。
 *
 * 只读、不触发任何更新动作：任何部署形态的人都能看到提示，但动手升级仍然走
 * 设置页（Docker 需要管理员 + updater 配置；fnOS / 群晖 / Windows 各自跳应用
 * 中心或桌面更新窗口）。
 */
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/server/auth";
import { loadUpdateNotice } from "@/lib/server/system-update/service";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "请先登录" }, { status: 401 });
  }

  const notice = await loadUpdateNotice();
  return NextResponse.json({
    ok: true,
    deploymentTarget: notice.deploymentTarget,
    canCheck: notice.canCheck,
    available: notice.available,
    localVersion: notice.localVersion,
    remoteVersion: notice.remoteVersion,
    remoteCommit: notice.remoteCommit,
    source: notice.source,
    checkedAt: notice.checkedAt,
    fetchError: notice.fetchError,
  });
}
