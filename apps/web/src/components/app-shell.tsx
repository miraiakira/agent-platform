"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button, Select, Skeleton, Tooltip } from "antd";
import { authClient } from "@/lib/auth-client";
import { friendlyError } from "@/lib/ui-errors";
import { roleLabels, useWorkspace } from "./workspace-provider";
import { Icon, type IconName } from "./ui/icon";
const navigation: Array<{ href: string; label: string; caption: string; icon: IconName }> = [
  { href: "/", label: "工作空间", caption: "Overview", icon: "grid" },
  { href: "/agent", label: "风控 Agent", caption: "Risk analysis", icon: "agent" },
  { href: "/chat", label: "AI 对话", caption: "Assistant", icon: "chat" },
  { href: "/approvals", label: "人工审批", caption: "Approvals", icon: "shield" },
  { href: "/prompts", label: "Prompt 管理", caption: "PromptOps", icon: "activity" },
  { href: "/evaluations", label: "Agent 评测", caption: "Evaluation", icon: "activity" },
  { href: "/security", label: "组织与权限", caption: "Organization", icon: "shield" },
];
export function Brand({ compact = false }: { compact?: boolean }) {
  return <Link href="/" className="brand" aria-label="EAP 工作空间首页"><span className="brand-symbol"><Icon name="agent" size={24}/></span><span><strong>EAP<span className="brand-word"> Workspace</span></strong>{!compact && <small>Enterprise Agent Platform</small>}</span></Link>;
}
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const workspace = useWorkspace();
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState("");
  if (pathname === "/login") return <><a className="skip-link" href="#main-content">跳转到主要内容</a>{children}</>;
  const active = navigation.find(item => item.href === pathname);
  return <div className="app-shell">
    <a className="skip-link" href="#main-content">跳转到主要内容</a>
    <aside className="app-sidebar">
      <Brand/>
      <div className="nav-caption">工作台 <span>WORKSPACE</span></div>
      <nav className="main-nav" aria-label="主导航">{navigation.map(item => <Link key={item.href} href={item.href} aria-current={pathname === item.href ? "page" : undefined} className={`nav-item ${pathname === item.href ? "is-active" : ""}`}><Icon name={item.icon}/><span>{item.label}<small>{item.caption}</small></span>{pathname === item.href && <span className="nav-active-dot"/>}</Link>)}</nav>
      <div className="sidebar-bottom"><span className="sidebar-note-icon"><Icon name="shield" size={18}/></span><strong>为团队协作而构建</strong><p>组织隔离 · 权限控制<br/>每次执行，清晰可追溯</p><span className="sidebar-version">EAP / ENTERPRISE WORKSPACE</span></div>
    </aside>
    <div className="app-body">
      <header className="app-header">
        <div className="breadcrumb"><span>工作台</span><Icon name="chevron" size={13}/><strong>{active?.label ?? "工作空间"}</strong></div>
        <div className="header-actions">
          {workspace.sessionPending ? <Skeleton.Input active size="small" style={{ width: 200 }}/> : workspace.session ? <>
            <Select aria-label="当前组织" placeholder="选择组织" loading={workspace.tenantsPending} value={workspace.tenant?.id} className="tenant-selector" suffixIcon={<Icon name="building" size={16}/>} options={workspace.tenants.map(t => ({ value: t.id, label: t.name }))} onChange={workspace.selectTenant} notFoundContent={<Link href="/security">创建你的第一个组织</Link>}/>
            <div className="header-user"><span className="avatar avatar-small">{(workspace.session.user.name || workspace.session.user.email).slice(0, 1).toUpperCase()}</span><div><strong>{workspace.session.user.name || "团队成员"}</strong><small>{workspace.tenant ? roleLabels[workspace.tenant.role] : "尚未选择组织"}</small></div></div>
            <Tooltip title="退出登录"><Button aria-label="退出登录" type="text" icon={<Icon name="logout" size={18}/>} loading={signingOut} onClick={async () => {
              setSigningOut(true); setError("");
              try { const result = await authClient.signOut(); if (result.error) throw new Error(result.error.message ?? "退出失败"); document.cookie = "eap_tenant=; Path=/; Max-Age=0"; router.push("/login"); router.refresh(); }
              catch (error) { setError(friendlyError(error)); } finally { setSigningOut(false); }
            }}/></Tooltip>
          </> : <><span className="header-guest">你的团队 AI 工作空间</span><Link href="/login" className="button-link button-primary">登录 / 注册 <Icon name="arrow" size={15}/></Link></>}
        </div>
      </header>
      {(error || workspace.sessionError || workspace.tenantError) && <div className="shell-alert"><Alert showIcon type="warning" title={error || workspace.sessionError || workspace.tenantError} action={workspace.tenantError ? <Button size="small" onClick={() => void workspace.refreshTenants()}>重试</Button> : undefined}/></div>}
      <div className="page-content" id="main-content" tabIndex={-1}>{children}</div>
      <footer className="app-footer"><span>Enterprise Agent Platform</span><span>连接业务，让 AI 有序执行。</span></footer>
    </div>
  </div>;
}
