import { Sidebar } from "@/components/layout/Sidebar";
import { AIPanel } from "@/components/layout/AIPanel";
import { getCurrentUser } from "@/lib/server/auth";
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

  return (
    <div className="flex h-screen overflow-x-hidden overflow-y-hidden">
      <Suspense
        fallback={
          <div
            className={
              sidebarCollapsed
                ? "h-screen w-14 shrink-0 border-r border-foreground/5 bg-background"
                : "h-screen w-72 shrink-0 border-r border-foreground/5 bg-background"
            }
          />
        }
      >
        <Sidebar />
      </Suspense>
      <main className="min-h-0 min-w-0 flex-1 flex flex-col h-screen overflow-x-hidden overflow-y-hidden bg-background">
        {children}
      </main>
      <AIPanel initialCollapsed={aiPanelCollapsed} />
    </div>
  );
}
