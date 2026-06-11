import { Sidebar } from "@/components/layout/Sidebar";
import { AIPanel } from "@/components/layout/AIPanel";

export const dynamic = "force-dynamic";

export default function SidebarLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-screen overflow-x-auto overflow-y-hidden">
      <Sidebar />
      <main className="min-h-0 min-w-0 flex-1 flex flex-col h-screen overflow-x-hidden overflow-y-hidden bg-background">
        {children}
      </main>
      <AIPanel />
    </div>
  );
}