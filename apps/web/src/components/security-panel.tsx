'use client';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Form, Input, Select, Space, Switch, Table, Typography } from 'antd';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { authClient } from '@/lib/auth-client';
type Tenant={id:string;name:string;role:string};
type Member={user_id:string;name:string;email:string;role:string;status:string};
type Policy={tool_name:string;enabled:boolean;allowed_roles:string[];risk_level:string;requires_approval:boolean;policy_version:number};
const roleOptions=['owner','admin','member','viewer'].map(value=>({value,label:value}));
async function api(path:string,body?:unknown){
 const response=await fetch(path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 const data=await response.json();if(!response.ok)throw new Error(data.error??`HTTP ${response.status}`);return data;
}
export function SessionBar(){
 const router=useRouter();
 const {data:session,isPending}=authClient.useSession();
 const [tenants,setTenants]=useState<Tenant[]>([]);const [tenant,setTenant]=useState('');const [error,setError]=useState('');
 useEffect(()=>{if(!session)return;let active=true;
  api('/api/tenants').then(data=>{if(!active)return;setTenants(data.tenants);
   const selected=document.cookie.match(/(?:^|;\s*)eap_tenant=([0-9a-f-]+)/)?.[1];
   if(selected&&data.tenants.some((t:Tenant)=>t.id===selected))setTenant(selected);
  }).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};
 },[session]);
 if(isPending)return <p role="status">正在读取登录状态…</p>;
 if(!session)return <nav className="p-4"><Link href="/login">登录 / 注册</Link></nav>;
 return <nav className="border-b bg-white p-4"><Space wrap>
  <span>{session.user.email}</span>
  <Select aria-label="当前组织" placeholder="请选择组织" value={tenant||undefined} style={{minWidth:200}} options={tenants.map(t=>({value:t.id,label:`${t.name} · ${t.role}`}))} onChange={value=>{
   document.cookie=`eap_tenant=${value}; Path=/; SameSite=Lax${location.protocol==='https:'?'; Secure':''}`;setTenant(value);location.reload();
  }}/>
  <Link href="/security">组织与权限</Link><Link href="/agent">Agent</Link>
  <Button onClick={async()=>{await authClient.signOut();document.cookie='eap_tenant=; Path=/; Max-Age=0';router.push('/login');router.refresh();}}>退出登录</Button>
 </Space>{error&&<Alert type="error" title={error}/>}</nav>;
}
export function LoginPanel(){
 const router=useRouter();
 const [register,setRegister]=useState(false);const [error,setError]=useState('');const [busy,setBusy]=useState(false);
 return <section className="mx-auto max-w-md p-8"><Typography.Title level={2}>{register?'注册':'登录'}</Typography.Title>
 {error&&<Alert type="error" title={error}/>}
 <Form layout="vertical" onFinish={async(values:{name?:string;email:string;password:string})=>{
  setBusy(true);setError('');try{
   const result=register?await authClient.signUp.email({name:values.name!,email:values.email,password:values.password}):await authClient.signIn.email({email:values.email,password:values.password});
   if(result.error)throw new Error(result.error.message??'认证失败');router.push('/security');router.refresh();
  }catch(e){setError(e instanceof Error?e.message:'认证失败');}finally{setBusy(false);}
 }}>
 {register&&<Form.Item name="name" label="姓名" rules={[{required:true,max:120}]}><Input autoComplete="name"/></Form.Item>}
 <Form.Item name="email" label="邮箱" rules={[{required:true,type:'email'}]}><Input autoComplete="email"/></Form.Item>
 <Form.Item name="password" label="密码（至少 12 位）" rules={[{required:true,min:12}]}><Input.Password autoComplete={register?'new-password':'current-password'}/></Form.Item>
 <Space><Button htmlType="submit" type="primary" loading={busy}>{register?'注册':'登录'}</Button><Button onClick={()=>setRegister(!register)}>{register?'已有账号':'创建账号'}</Button></Space>
 </Form>
 <p className="my-4">注册后创建组织，或把登录后的用户 ID 交给组织管理员加入。</p>
 <Button onClick={async()=>{const result=await authClient.signIn.social({provider:'google',callbackURL:'/security'});if(result.error)setError(result.error.message??'Google OAuth 尚未配置');}}>Google 登录（需管理员配置）</Button>
 </section>;
}
export function SecurityPanel(){
 const {data:session}=authClient.useSession();const [members,setMembers]=useState<Member[]>([]);const [policies,setPolicies]=useState<Policy[]>([]);const [error,setError]=useState('');
 const load=useCallback(async()=>{try{const [m,p]=await Promise.all([api('/api/security/members'),api('/api/security/policies')]);setMembers(m.members);setPolicies(p.policies);setError('');}catch(e){setError(e instanceof Error?e.message:'加载失败');}},[]);
 useEffect(()=>{let active=true;
  Promise.all([api('/api/security/members'),api('/api/security/policies')]).then(([m,p])=>{if(active){setMembers(m.members);setPolicies(p.policies);}}).catch(e=>{if(active)setError(e.message);});
  return()=>{active=false;};
 },[]);
 const mine=members.find(m=>m.user_id===session?.user.id);const manage=mine?.role==='owner'||mine?.role==='admin';
 async function action(path:string,body:unknown){try{await api(path,body);await load();}catch(e){setError(e instanceof Error?e.message:'操作失败');}}
 return <main className="mx-auto max-w-5xl space-y-6 p-6"><Typography.Title level={2}>组织与权限</Typography.Title>
 {error&&<Alert type="warning" title={error} description="请登录并选择组织。权限不足时请联系组织管理员。"/>}
 {session&&<p>当前用户 ID：<code>{session.user.id}</code>（管理员添加成员时使用）</p>}
 <Form layout="inline" onFinish={async(values:{name:string})=>{try{const {tenant}=await api('/api/tenants',values);document.cookie=`eap_tenant=${tenant.id}; Path=/; SameSite=Lax${location.protocol==='https:'?'; Secure':''}`;location.reload();}catch(e){setError(e instanceof Error?e.message:'创建失败');}}}>
 <Form.Item name="name" label="新组织名称" rules={[{required:true,max:120}]}><Input/></Form.Item><Button htmlType="submit">创建组织</Button>
 </Form>
 <Typography.Title level={3}>成员</Typography.Title>
 <Table rowKey="user_id" dataSource={members} columns={[{title:'姓名',dataIndex:'name'},{title:'邮箱',dataIndex:'email'},{title:'角色',dataIndex:'role'},{title:'状态',dataIndex:'status'}]}/>
 {manage&&<Form layout="inline" initialValues={{role:'member',status:'active'}} onFinish={values=>action('/api/security/members',values)}>
 <Form.Item name="userId" label="已注册用户 ID" rules={[{required:true}]}><Input/></Form.Item><Form.Item name="role" label="角色"><Select style={{width:110}} options={roleOptions}/></Form.Item>
 <Form.Item name="status" label="状态"><Select style={{width:110}} options={['active','removed'].map(value=>({value,label:value}))}/></Form.Item><Button htmlType="submit">添加 / 更新成员</Button>
 </Form>}
 <Typography.Title level={3}>工具策略</Typography.Title>
 {policies.map(p=><Form key={`${p.tool_name}-${p.policy_version}`} layout="vertical" initialValues={{enabled:p.enabled,allowed_roles:p.allowed_roles,risk_level:p.risk_level,requires_approval:p.requires_approval}} disabled={!manage} onFinish={values=>action('/api/security/policies',{tool_name:p.tool_name,...values})}>
 <p>{p.tool_name} · 策略版本 {p.policy_version}</p>
 <Form.Item name="enabled" label="启用" valuePropName="checked"><Switch/></Form.Item>
 <Form.Item name="allowed_roles" label="允许角色"><Select mode="multiple" options={roleOptions}/></Form.Item>
 <Form.Item name="risk_level" label="风险等级"><Select options={['low','high'].map(value=>({value,label:value}))}/></Form.Item>
 <Form.Item name="requires_approval" label="需要审批（开启后拒绝自动执行）" valuePropName="checked"><Switch/></Form.Item>
 <Button htmlType="submit">保存策略</Button></Form>)}
 {manage&&<Button danger onClick={()=>action('/api/security/tenant',{status:'disabled'})}>停用当前组织</Button>}
 <p>Session 退出不取消已提交任务；移除成员、停用组织或撤销工具策略后，后续工具执行拒绝。组织停用后的恢复需运维管理路径。</p>
 </main>;
}
