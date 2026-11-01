"use client";
import { App, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { WorkspaceProvider } from "./workspace-provider";
export function AppProviders({ children }: { children: React.ReactNode }) {
  return <ConfigProvider locale={zhCN} theme={{ token: {
    colorPrimary: "#176b57", colorInfo: "#176b57", colorText: "#20352f", colorTextSecondary: "#627265", colorTextPlaceholder: "#6d7967",
    colorBorder: "#dce4df", colorBgLayout: "#f5f7f5", borderRadius: 9, controlHeight: 40,
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  }, components: {
    Button: { primaryShadow: "none", fontWeight: 500 },
    Card: { headerFontSize: 15, headerHeight: 60 },
    Table: { headerBg: "#f7f9f7", headerColor: "#718078", cellPaddingBlock: 16 },
    Tabs: { titleFontSize: 14, horizontalItemGutter: 28 },
  } }}><App><WorkspaceProvider>{children}</WorkspaceProvider></App></ConfigProvider>;
}
