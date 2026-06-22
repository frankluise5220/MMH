import "./globals.css";
import Script from "next/script";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <Script
          id="performance-measure-guard"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html: `
              (() => {
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
      </head>
      <body
        suppressHydrationWarning
        className="antialiased h-screen overflow-x-auto overflow-y-hidden"
      >
        {children}
      </body>
    </html>
  );
}
