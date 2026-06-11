import "./globals.css";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body
        suppressHydrationWarning
        className="antialiased h-screen overflow-x-auto overflow-y-hidden"
      >
        {children}
      </body>
    </html>
  );
}