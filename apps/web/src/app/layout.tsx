import type { Metadata } from "next";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import { Suspense } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Enterprise Agent Platform",
  description: "Enterprise AI Agent Development Platform",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen bg-slate-50">
        <Suspense
          fallback={
            <main className="mx-auto min-h-screen max-w-6xl p-6 md:p-10">
              <p role="status">正在加载应用…</p>
            </main>
          }
        >
          <AntdRegistry>{children}</AntdRegistry>
        </Suspense>
      </body>
    </html>
  );
}
