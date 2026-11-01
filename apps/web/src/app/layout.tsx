import { AppProviders } from "@/components/app-providers";
import { AppShell } from "@/components/app-shell";
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
      <body>
        <Suspense
          fallback={
            <main className="mx-auto min-h-screen max-w-6xl p-6 md:p-10">
              <p role="status">正在加载应用…</p>
            </main>
          }
        >
          <AntdRegistry><AppProviders><AppShell>{children}</AppShell></AppProviders></AntdRegistry>
        </Suspense>
      </body>
    </html>
  );
}
