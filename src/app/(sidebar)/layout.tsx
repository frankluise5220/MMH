import { Sidebar } from "@/components/layout/Sidebar";
import { AIPanel } from "@/components/layout/AIPanel";
import { BackgroundTaskStatusBar } from "@/components/BackgroundTaskStatusBar";
import { FirstUseGuide } from "@/components/FirstUseGuide";
import { MobileNavigation } from "@/components/layout/MobileNavigation";
import { MobilePullToRefresh } from "@/components/layout/MobilePullToRefresh";
import { getCurrentUser } from "@/lib/server/auth";
import { getDeviceKind } from "@/lib/server/device-kind";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

export default async function SidebarLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const currentUser = await getCurrentUser();
  if (!currentUser) redirect("/login");
  const cookieStore = await cookies();
  const aiPanelCollapsed = (() => {
    const value = cookieStore.get("mmh_ai_panel_collapsed")?.value;
    return value === "1" || value === "true";
  })();
  const sidebarCollapsed = cookieStore.get("sidebar_collapsed")?.value === "true";
  // 外壳形态跟设备走，不跟窗口宽度走：手机上永远是「底部导航 + 全屏内容」，
  // 桌面浏览器把窗口拉窄也还是「侧边栏 + 内容」，不会突然换成移动版。
  const deviceKind = await getDeviceKind();
  const isMobileDevice = deviceKind === "mobile";

  return (
    <div className="flex h-dvh overflow-x-hidden overflow-y-hidden" data-device={deviceKind}>
      <BackgroundTaskStatusBar />
      {/* 两层判断各管一件事：`isMobileDevice` 决定「有没有侧边栏这种形态」，
          `md:block` 只决定「这么窄的窗口还塞不塞得下 288px 侧边栏」。
          桌面浏览器把窗口拉到 390px 时侧边栏让位，但内容仍是桌面 panel/表格，
          不会因为变窄就换成手机的卡片列表。 */}
      {isMobileDevice ? null : (
        <div className="hidden h-dvh shrink-0 md:block">
          <Suspense
            fallback={
              <div
                className={
                  sidebarCollapsed
                    ? "h-dvh w-14 shrink-0 border-r border-foreground/5 bg-background"
                    : "h-dvh w-72 shrink-0 border-r border-foreground/5 bg-background"
                }
              />
            }
          >
            <Sidebar />
          </Suspense>
        </div>
      )}
      <main
        className={
          isMobileDevice
            ? "flex h-dvh min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-hidden bg-background pb-[calc(5.75rem+env(safe-area-inset-bottom))] pt-[env(safe-area-inset-top)]"
            : "flex h-dvh min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-hidden bg-background"
        }
      >
        <FirstUseGuide>{children}</FirstUseGuide>
      </main>
      {isMobileDevice ? null : (
        <div className="hidden h-dvh shrink-0 xl:block">
          <AIPanel initialCollapsed={aiPanelCollapsed} />
        </div>
      )}
      {isMobileDevice ? (
        <Suspense fallback={null}>
          <MobilePullToRefresh />
          <MobileNavigation />
        </Suspense>
      ) : null}
    </div>
  );
}
