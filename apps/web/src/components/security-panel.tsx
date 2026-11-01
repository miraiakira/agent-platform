"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Alert, Button, Empty, Form, Input, Popconfirm, Select, Skeleton, Switch, Table, Tabs, Tag, Typography } from "antd";
import { friendlyError, requestJson } from "@/lib/ui-errors";
import { persistTenant, roleLabels, useWorkspace, type Role } from "./workspace-provider";
import { Icon } from "./ui/icon";
import { PageHeading } from "./ui/page-heading";
type Member = { user_id: string; name: string; email: string; role: Role; status: string };
type Policy = { tool_name: string; enabled: boolean; allowed_roles: Role[]; risk_level: "low" | "high"; requires_approval: boolean; policy_version: number };
type Settings = { tenantId?: string; members: Member[]; policies: Policy[]; error: string };
const roleOptions = (Object.entries(roleLabels) as Array<[Role, string]>).map(([value, label]) => ({ value, label: `${label} · ${value}` }));
async function fetchSettings() {
  const [members, policies] = await Promise.all([
    requestJson<{ members: Member[] }>("/api/security/members"),
    requestJson<{ policies: Policy[] }>("/api/security/policies"),
  ]);
  return { members: members.members, policies: policies.policies };
}
function CreateOrganization({ onError }: { onError: (error: string) => void }) {
  const [busy, setBusy] = useState(false);
  return <Form layout="vertical" requiredMark={false} onFinish={async (values: { name: string }) => {
    setBusy(true); onError("");
    try { const { tenant } = await requestJson<{ tenant: { id: string } }>("/api/tenants", { name: values.name.trim() }); persistTenant(tenant.id); location.reload(); }
    catch (error) { onError(friendlyError(error)); setBusy(false); }
  }}><Form.Item name="name" label="组织名称" rules={[{ required: true, whitespace: true, message: "请输入组织名称" }, { max: 120, message: "最多 120 个字符" }]}><Input placeholder="例如：风控研究团队" disabled={busy} maxLength={120}/></Form.Item><Button type="primary" htmlType="submit" icon={<Icon name="plus" size={16}/>} loading={busy}>创建组织</Button></Form>;
}
export function SecurityPanel() {
  const { session, sessionPending, tenant, tenantsPending, canManage, refreshTenants } = useWorkspace();
  const userId = session?.user.id;
  const tenantId = tenant?.id;
  const [state, setState] = useState<Settings>({ members: [], policies: [], error: "" });
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: "error" | "success" | "warning"; text: string } | null>(null);
  useEffect(() => {
    if (!tenantId || !userId) return;
    let active = true;
    fetchSettings().then(data => { if (active) setState({ tenantId, ...data, error: "" }); })
      .catch(error => { if (active) setState({ tenantId, members: [], policies: [], error: friendlyError(error) }); });
    return () => { active = false; };
  }, [tenantId, userId]);
  const data = state.tenantId === tenantId ? state : { members: [], policies: [], error: "" };
  const loading = !!tenantId && state.tenantId !== tenantId;
  const mine = data.members.find(member => member.user_id === userId && member.status === "active");
  const manage = canManage && (mine?.role === "owner" || mine?.role === "admin");
  async function runAction(path: string, body: unknown, success: string) {
    setPending(path); setNotice(null);
    try {
      await requestJson(path, body);
      if (path.endsWith("/tenant")) { location.reload(); return; }
      setNotice({ type: "success", text: success });
      try {
        const [updated] = await Promise.all([fetchSettings(), refreshTenants()]);
        setState({ tenantId, ...updated, error: "" });
      } catch {
        setNotice({ type: "warning", text: "修改已保存，但最新信息暂时无法加载；请刷新页面检查当前权限与状态。" });
      }
    } catch (error) { setNotice({ type: "error", text: friendlyError(error) }); }
    finally { setPending(null); }
  }
  const heading = <PageHeading eyebrow="ORGANIZATION & ACCESS" title="组织与权限" description="让合适的人使用合适的工具，建立清晰的团队协作边界。" extra={tenant ? <span className="quiet-badge"><Icon name="building" size={15}/>{tenant.name}</span> : undefined}/>;
  if (sessionPending || tenantsPending) return <main>{heading}<div className="surface panel-padding"><Skeleton active paragraph={{ rows: 5 }}/></div></main>;
  if (!session) return <main>{heading}<div className="surface access-empty"><span className="empty-icon"><Icon name="shield" size={32}/></span><h2>先登录，再管理你的团队</h2><p>登录后可以创建组织、查看成员和设置工具权限。</p><Link className="button-link button-primary" href="/login">登录 / 注册 <Icon name="arrow" size={16}/></Link></div></main>;
  const identity = <div className="identity-note"><Icon name="users" size={17}/><span>你的用户 ID</span><Typography.Text copyable={{ text: userId }}>{userId}</Typography.Text><small>加入已有组织时，将此 ID 提供给管理员。</small></div>;
  if (!tenant) return <main>{heading}{identity}{notice && <Alert showIcon type={notice.type} title={notice.text}/>}<div className="organization-onboarding"><div className="surface onboarding-create"><span className="feature-icon feature-shield"><Icon name="building" size={26}/></span><h2>创建你的第一个组织</h2><p>你将成为组织所有者，随后可以邀请已注册成员并管理工具策略。</p><CreateOrganization onError={text => setNotice(text ? { type: "error", text } : null)}/></div><div className="surface onboarding-info"><p className="eyebrow">ALREADY PART OF A TEAM?</p><h3>加入已有组织</h3><ol className="onboarding-steps"><li>复制上方的用户 ID</li><li>请管理员将你添加到组织</li><li>刷新页面，在顶部选择组织</li></ol><Button icon={<Icon name="refresh" size={15}/>} onClick={() => void refreshTenants()}>刷新组织列表</Button></div></div></main>;
  const memberPanel = <section className="surface settings-card"><div className="settings-card-heading"><div><h2>团队成员 <span className="count-badge">{data.members.length}</span></h2><p>查看团队角色。管理员可以添加已注册用户或更新成员权限。</p></div><span className="quiet-badge"><Icon name="users" size={14}/>Membership</span></div><Table<Member> rowKey="user_id" dataSource={data.members} loading={loading} pagination={data.members.length > 10 ? { pageSize: 10 } : false} scroll={{ x: 640 }} locale={{ emptyText: <Empty description="暂无成员信息"/> }} columns={[
    { title: "成员", key: "member", render: (_, member) => <div className="member-identity"><span className="avatar">{(member.name || member.email).slice(0, 1).toUpperCase()}</span><div><strong>{member.name || "团队成员"}{member.user_id === userId && <span className="you-label">你</span>}</strong><small>{member.email}</small></div></div> },
    { title: "角色", dataIndex: "role", render: (role: Role) => <Tag className={`role-tag role-${role}`}>{roleLabels[role]} <span>{role}</span></Tag> },
    { title: "状态", dataIndex: "status", render: (status: string) => <span className={`status-pill ${status === "active" ? "status-success" : "status-neutral"}`}><span/>{status === "active" ? "有效" : "已移除"}</span> },
  ]}/>{manage ? <div className="member-editor"><div><h3><Icon name="plus" size={17}/>添加或更新成员</h3><p>使用对方个人页面中的用户 ID。至少保留一位有效的 Owner。</p></div><Form layout="vertical" requiredMark={false} initialValues={{ role: "member", status: "active" }} onFinish={values => void runAction("/api/security/members", values, "成员权限已更新。") }><div className="member-form-grid"><Form.Item name="userId" label="已注册用户 ID" rules={[{ required: true, whitespace: true, message: "请输入用户 ID" }, { max: 128, message: "用户 ID 最多 128 个字符" }]}><Input placeholder="粘贴对方的用户 ID" disabled={!!pending}/></Form.Item><Form.Item name="role" label="组织角色"><Select disabled={!!pending} options={roleOptions.filter(option => mine?.role === "owner" || option.value !== "owner")}/></Form.Item><Form.Item name="status" label="成员状态"><Select disabled={!!pending} options={[{ value: "active", label: "有效" }, { value: "removed", label: "移除成员" }]}/></Form.Item><Button htmlType="submit" type="primary" loading={pending === "/api/security/members"} disabled={!!pending}>保存成员</Button></div></Form></div> : <div className="read-only-note"><Icon name="lock" size={15}/>当前为只读视图。成员权限由 Owner 或 Admin 管理。</div>}</section>;
  const toolsPanel = <div className="policy-list">{!manage && <Alert showIcon type="info" title="你可以查看工具策略；修改需要 Owner 或 Admin 权限。"/>}{data.policies.length === 0 ? <div className="surface panel-padding"><Empty description="暂无可查看的工具策略"/></div> : data.policies.map(policy => <section className="surface settings-card" key={`${policy.tool_name}-${policy.policy_version}`}><div className="settings-card-heading"><div className="policy-identity"><span className="feature-icon feature-agent"><Icon name="shield" size={24}/></span><div><h2>{policy.tool_name === "get_high_risk_transactions" ? "高风险交易查询" : policy.tool_name}</h2><code>{policy.tool_name}</code></div></div><span className="quiet-badge">策略版本 {policy.policy_version}</span></div><Form layout="vertical" requiredMark={false} disabled={!manage || !!pending} initialValues={{ enabled: policy.enabled, allowed_roles: policy.allowed_roles, risk_level: policy.risk_level, requires_approval: policy.requires_approval }} onFinish={values => void runAction("/api/security/policies", { tool_name: policy.tool_name, ...values }, "工具策略已保存，后续工具执行将检查最新策略。") }><div className="policy-form-content"><div className="setting-switch-row"><div><h3>允许组织使用此工具</h3><p>关闭后，组织内所有角色都无法执行此工具。</p></div><Form.Item name="enabled" valuePropName="checked" noStyle><Switch aria-label="启用高风险交易查询工具"/></Form.Item></div><div className="policy-form-grid"><Form.Item name="allowed_roles" label="允许执行的角色" extra="工具权限还会同时检查成员角色与组织状态。"><Select mode="multiple" options={roleOptions} placeholder="选择允许的角色"/></Form.Item><Form.Item name="risk_level" label="工具风险等级"><Select options={[{ value: "low", label: "低风险" }, { value: "high", label: "高风险" }]}/></Form.Item></div><div className="setting-switch-row approval-row"><div><h3><Icon name="lock" size={15}/>执行前需要人工审批</h3><p>当前尚未开放审批流程，启用此项后将拒绝自动执行。</p></div><Form.Item name="requires_approval" valuePropName="checked" noStyle><Switch aria-label="执行前需要人工审批"/></Form.Item></div></div><div className="settings-form-footer"><span><Icon name="shield" size={14}/>策略变更会写入安全审计记录</span><Button type="primary" htmlType="submit" loading={pending === "/api/security/policies"}>保存策略</Button></div></Form></section>)}</div>;
  const organizationPanel = <div className="organization-settings-grid"><section className="surface settings-card panel-padding"><div className="section-heading"><h2>创建另一个组织</h2><Icon name="building" size={20}/></div><p className="muted-text">为不同团队或业务建立独立工作空间。</p><CreateOrganization onError={text => setNotice(text ? { type: "error", text } : null)}/></section><section className="surface settings-card panel-padding danger-card"><div className="section-heading"><h2>停用当前组织</h2><Icon name="lock" size={20}/></div><p className="muted-text">停用后成员无法访问组织，后续工具执行将被拒绝。恢复需要运维管理路径。</p><Popconfirm title="确认停用当前组织？" description="此操作会影响全部成员，恢复需要联系运维管理员。" okText="确认停用" cancelText="取消" okButtonProps={{ danger: true }} disabled={!manage || !!pending} onConfirm={() => runAction("/api/security/tenant", { status: "disabled" }, "组织已停用。")}><Button danger disabled={!manage || !!pending} loading={pending === "/api/security/tenant"}>停用当前组织</Button></Popconfirm></section></div>;
  return <main className="security-page">{heading}{identity}{notice && <Alert showIcon type={notice.type} title={notice.text} className="form-alert" closable onClose={() => setNotice(null)}/>}<div className="security-summary"><span className="feature-icon feature-shield"><Icon name="shield" size={22}/></span><div><strong>{tenant.name}</strong><p>权限基于当前组织生效，工具会在实际执行前重新校验授权。</p></div><Tag className={`role-tag role-${mine?.role ?? tenant.role}`}>{roleLabels[mine?.role ?? tenant.role]}</Tag></div>{data.error ? <Alert showIcon type="warning" title={data.error} action={<Button onClick={async () => { try { setState({ tenantId, ...await fetchSettings(), error: "" }); } catch (error) { setState({ tenantId, members: [], policies: [], error: friendlyError(error) }); } }}>重试</Button>}/> : <Tabs className="settings-tabs" items={[{ key: "members", label: <span className="tab-label"><Icon name="users" size={17}/>团队成员</span>, children: memberPanel }, { key: "policies", label: <span className="tab-label"><Icon name="shield" size={17}/>工具策略</span>, children: toolsPanel }, { key: "organization", label: <span className="tab-label"><Icon name="building" size={17}/>组织设置</span>, children: organizationPanel }]}/>}<p className="settings-security-note"><Icon name="lock" size={14}/>退出登录不会取消已授权的任务；成员与工具权限的撤销会阻止后续敏感工具执行。</p></main>;
}
