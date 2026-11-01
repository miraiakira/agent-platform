"use client";
import Link from "next/link";
import { ApiStatus } from "@/components/api-status";
import { useWorkspace, roleLabels } from "@/components/workspace-provider";
import { Icon, type IconName } from "@/components/ui/icon";
import { PageHeading } from "@/components/ui/page-heading";
const features: Array<{ href: string; icon: IconName; label: string; english: string; description: string; tag: string }> = [
  { href: "/agent", icon: "agent", label: "风控分析 Agent", english: "RISK ANALYSIS", description: "从一个业务问题开始，连接交易工具，获取有依据的风险分析。", tag: "工具调用 · 异步执行" },
  { href: "/chat", icon: "chat", label: "AI 对话助手", english: "AI ASSISTANT", description: "梳理想法、理解信息，与 AI 进行连贯而专注的交流。", tag: "实时回复 · 连续对话" },
  { href: "/security", icon: "shield", label: "组织与权限", english: "TEAM & ACCESS", description: "管理团队成员与工具策略，为每一次业务执行设置合适的权限。", tag: "角色管理 · 工具授权" },
];
export default function Home() {
  const { session, tenant, tenants, sessionPending } = useWorkspace();
  const next = !session ? "/login" : !tenant ? "/security" : "/agent";
  return <main className="dashboard-page">
    <PageHeading eyebrow="WORKSPACE OVERVIEW" title="工作空间" description="你的 AI、业务工具与团队协作，从这里开始。" extra={<span className="quiet-badge"><Icon name="building" size={14}/>{tenant?.name ?? "Enterprise Workspace"}</span>}/>
    <section className="welcome-card">
      <div className="welcome-copy"><span className="hero-label"><span/> ENTERPRISE AI, IN YOUR CONTROL</span><h2>{sessionPending ? "欢迎来到你的工作空间" : session ? `欢迎回来，${session.user.name || "团队成员"}` : "让业务问题，找到清晰答案。"}</h2><p>连接模型与业务工具，在团队权限边界内，<br className="desktop-break"/>把问题转化为可执行、可追溯的分析。</p><div className="hero-actions"><Link className="button-link button-primary" href={next}>{!session ? "开启你的工作空间" : !tenant ? "设置组织" : "开始分析"}<Icon name="arrow" size={17}/></Link><Link className="text-link" href="/chat">探索 AI 对话 <Icon name="arrow" size={15}/></Link></div></div>
      <div className="workflow-illustration" aria-hidden="true"><div className="workflow-topline"><span className="tiny-dot"/> AGENT WORKFLOW <span className="workflow-label">EAP</span></div><div className="workflow-node"><span className="workflow-icon"><Icon name="chat" size={20}/></span><div><strong>提出业务问题</strong><small>Understand the context</small></div><span className="workflow-step">01</span></div><div className="workflow-connector"/><div className="workflow-node workflow-node-active"><span className="workflow-icon"><Icon name="agent" size={20}/></span><div><strong>授权与工具执行</strong><small>Reason, authorize, act</small></div><span className="workflow-step">02</span></div><div className="workflow-connector"/><div className="workflow-node"><span className="workflow-icon"><Icon name="check" size={20}/></span><div><strong>输出分析与记录</strong><small>Answers with a trace</small></div><span className="workflow-step">03</span></div></div>
    </section>
    <div className="section-heading"><h2>选择你的下一步</h2><span>为不同任务，找到合适的入口</span></div>
    <section className="feature-grid" aria-label="工作空间入口">{features.map(item => <Link key={item.href} href={item.href} className="feature-card"><div className="feature-card-top"><span className={`feature-icon feature-${item.icon}`}><Icon name={item.icon} size={23}/></span><Icon name="arrow" size={19}/></div><p className="eyebrow">{item.english}</p><h3>{item.label}</h3><p>{item.description}</p><span className="feature-tag">{item.tag}</span></Link>)}</section>
    <section className="dashboard-bottom"><div className="surface workspace-card"><div className="section-heading"><h2>当前工作空间</h2><Icon name="building" size={20}/></div>{session ? <><div className="workspace-identity"><span className="avatar avatar-large">{(tenant?.name ?? session.user.name ?? "E").slice(0, 1).toUpperCase()}</span><div><h3>{tenant?.name ?? "先选择一个组织"}</h3><p>{tenant ? `${roleLabels[tenant.role]} · ${session.user.email}` : "创建组织，或让管理员添加你加入团队。"}</p></div></div><div className="workspace-card-footer"><span>已加入 {tenants.length} 个组织</span><Link href="/security" className="text-link">管理工作空间 <Icon name="arrow" size={15}/></Link></div></> : <div className="workspace-empty"><p>登录后选择组织，开始与团队一起工作。</p><Link className="text-link" href="/login">登录或创建账号 <Icon name="arrow" size={15}/></Link></div>}</div><ApiStatus/></section>
  </main>;
}
