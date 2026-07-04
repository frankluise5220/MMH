import "./globals.css";
import Script from "next/script";
import { ModalDragController } from "@/components/ModalDragController";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body
        suppressHydrationWarning
        className="antialiased h-screen overflow-x-hidden overflow-y-hidden"
      >
        {children}
        <ModalDragController />
        <Script
          id="performance-measure-guard"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html: `
              (() => {
                try {
                  const persist = (key, value) => {
                    if (value === null || value === undefined) return;
                    document.cookie = key + "=" + encodeURIComponent(value) + "; path=/; max-age=31536000; samesite=lax";
                  };
                  persist("sidebar_collapsed", localStorage.getItem("sidebar_collapsed"));
                  persist("sidebar_group_by", localStorage.getItem("sidebar_group_by"));
                  persist("sidebar_hide_zero", localStorage.getItem("sidebar_hide_zero"));
                  persist("sidebar_owner_filter", localStorage.getItem("sidebar_owner_filter"));
                  persist("mmh_ai_panel_collapsed", localStorage.getItem("mmh_ai_panel_collapsed"));
                } catch (error) {}
                const perf = window.performance;
                if (!perf || typeof perf.measure !== "function" || perf.__mmhMeasureGuard) return;
                const originalMeasure = perf.measure.bind(perf);
                Object.defineProperty(perf, "__mmhMeasureGuard", { value: true });
                perf.measure = function(name, startOrOptions, endMark) {
                  try {
                    return originalMeasure(name, startOrOptions, endMark);
                  } catch (error) {
                    const message = error && typeof error.message === "string" ? error.message : "";
                    if (message.includes("negative time stamp")) {
                      return { name, entryType: "measure", startTime: 0, duration: 0 };
                    }
                    throw error;
                  }
                };
              })();
            `,
          }}
        />
      </body>
    </html>
  );
}
