"use client";
import { Alert, Button, Form, Input } from "antd";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { friendlyError } from "@/lib/ui-errors";
import { Brand } from "./app-shell";
import { Icon } from "./ui/icon";
import { useWorkspace } from "./workspace-provider";
export function LoginPanel() {
  const router = useRouter();
  const { session } = useWorkspace();
  const [register, setRegister] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  return <main className="login-page" id="main-content">
    <section className="login-story"><Brand/><div className="login-story-main"><span className="hero-label"><span/> YOUR TEAM. YOUR WORKSPACE.</span><h2>让 AI 走进业务，<br/>让团队协作更有序。</h2><p>从业务问题到工具执行，<br/>在清晰的权限边界内，完成每一步。</p><div className="login-story-features">{[{ icon: "agent" as const, title: "连接业务的 Agent", text: "结合模型推理与真实业务工具" }, { icon: "users" as const, title: "为团队构建的空间", text: "组织、成员与角色各司其职" }, { icon: "shield" as const, title: "有边界的工具执行", text: "执行前授权，关键操作可追溯" }].map(item => <div key={item.title}><span><Icon name={item.icon} size={20}/></span><div><strong>{item.title}</strong><small>{item.text}</small></div></div>)}</div></div><span className="login-story-footer">ENTERPRISE AGENT PLATFORM</span></section>
    <section className="login-form-side"><Link href="/" className="login-back text-link">返回工作空间 <Icon name="arrow" size={16}/></Link><div className="login-form-wrap"><div className="mobile-login-brand"><Brand compact/></div><span className="eyebrow">WELCOME TO EAP</span><h1>{register ? "创建你的账号" : "欢迎回来"}</h1><p className="login-description">{register ? "先创建账号，再创建组织或加入你的团队。" : "登录你的账号，继续与团队一起工作。"}</p>
      {session && <Alert type="info" showIcon title={`已登录：${session.user.email}`} action={<Link href="/security">进入组织</Link>}/>}
      {error && <Alert type="error" showIcon title={error} className="form-alert"/>}
      <Form layout="vertical" size="large" requiredMark={false} key={register ? "register" : "login"} onFinish={async (values: { name?: string; email: string; password: string }) => {
        setBusy(true); setError("");
        try { const result = register ? await authClient.signUp.email({ name: values.name!, email: values.email, password: values.password }) : await authClient.signIn.email({ email: values.email, password: values.password }); if (result.error) throw new Error(result.error.message ?? "认证失败"); router.push("/security"); router.refresh(); }
        catch (error) { setError(friendlyError(error, "登录失败，请检查邮箱和密码。")); } finally { setBusy(false); }
      }}>
        {register && <Form.Item name="name" label="姓名" rules={[{ required: true, message: "请输入姓名" }, { max: 120, message: "姓名最多 120 个字符" }]}><Input autoComplete="name" placeholder="你的名字" disabled={busy || googleBusy}/></Form.Item>}
        <Form.Item name="email" label="邮箱地址" rules={[{ required: true, message: "请输入邮箱地址" }, { type: "email", message: "请输入有效的邮箱地址" }]}><Input autoComplete="email" placeholder="you@company.com" disabled={busy || googleBusy}/></Form.Item>
        <Form.Item name="password" label="密码" extra={register ? "使用至少 12 个字符，设置一个独立的安全密码。" : undefined} rules={[{ required: true, message: "请输入密码" }, { min: 12, message: "密码至少需要 12 个字符" }]}><Input.Password autoComplete={register ? "new-password" : "current-password"} placeholder={register ? "设置你的密码" : "输入登录密码"} disabled={busy || googleBusy}/></Form.Item>
        <Button htmlType="submit" type="primary" block loading={busy} disabled={googleBusy} icon={<Icon name="arrow" size={18}/>}>{register ? "创建账号" : "登录工作空间"}</Button>
      </Form>
      <div className="login-divider"><span/>或使用其他方式<span/></div>
      <Button size="large" block loading={googleBusy} disabled={busy} onClick={async () => {
        setGoogleBusy(true); setError("");
        try { const result = await authClient.signIn.social({ provider: "google", callbackURL: "/security" }); if (result.error) throw new Error(result.error.message ?? "Google 登录暂不可用，请使用邮箱登录。"); }
        catch (error) { setError(friendlyError(error)); } finally { setGoogleBusy(false); }
      }}><svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-1.99 3.02v2.51h3.23c1.89-1.74 2.98-4.3 2.98-7.36Z"/><path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.62-2.41l-3.23-2.51c-.9.6-2.05.97-3.39.97-2.61 0-4.82-1.76-5.61-4.12H3.05v2.59A10 10 0 0 0 12 22Z"/><path fill="#FBBC05" d="M6.39 13.93A6 6 0 0 1 6.08 12c0-.67.11-1.32.31-1.93V7.48H3.05A10 10 0 0 0 2 12c0 1.61.39 3.14 1.05 4.52l3.34-2.59Z"/><path fill="#EA4335" d="M12 5.95c1.47 0 2.79.5 3.82 1.49l2.87-2.87A9.61 9.61 0 0 0 12 2a10 10 0 0 0-8.95 5.48l3.34 2.59C7.18 7.71 9.39 5.95 12 5.95Z"/></svg>使用 Google 登录</Button>
      <p className="login-toggle">{register ? "已经有账号了？" : "还没有账号？"}<Button type="link" disabled={busy || googleBusy} onClick={() => { setRegister(!register); setError(""); }}>{register ? "立即登录" : "创建账号"}</Button></p>
      <p className="login-footnote"><Icon name="lock" size={13}/>登录信息由安全 Session 管理</p>
    </div><div className="login-bottom">Enterprise Agent Platform · 为团队而构建</div></section>
  </main>;
}
