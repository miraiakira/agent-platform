"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Descriptions, Drawer, Empty, Input, Space, Table, Tag, Typography } from 'antd';
import { useWorkspace } from './workspace-provider';
import { responseError, friendlyError } from '@/lib/ui-errors';
async function approvalRequest<T>(path:string,init?:RequestInit):Promise<T>{const response=await fetch(path,init);if(!response.ok)throw new Error(await responseError(response));return response.json();}
type Approval={id:string;run_id:string;tool_name:string;risk_level:string;requested_by_user_id:string;requested_at:string;expires_at:string;status:string;display_arguments:Record<string,unknown>;decision_reason:string|null};
const labels:Record<string,string>={pending:'待审批',approved:'已批准',rejected:'已拒绝',expired:'已过期',cancelled:'已取消'};
export function ApprovalPanel(){
 const {tenant,canManage,session}=useWorkspace();
 const [rows,setRows]=useState<Approval[]>([]),[detail,setDetail]=useState<Approval>(),[reason,setReason]=useState('');
 const [decidedRun,setDecidedRun]=useState<string>();
 const [busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState('');
 const load=useCallback(async(signal?:AbortSignal)=>{
  if(!signal)setLoading(true);try{const result=await approvalRequest<{approvals:Approval[]}>('/api/approvals',{signal});if(!signal?.aborted)setRows(result.approvals);}
  catch(e){if(!signal?.aborted)setError(friendlyError(e));}finally{if(!signal?.aborted)setLoading(false);}
 },[]);
 useEffect(()=>{if(!canManage)return;const controller=new AbortController();approvalRequest<{approvals:Approval[]}>('/api/approvals',{signal:controller.signal}).then(result=>{if(!controller.signal.aborted){setRows(result.approvals);setLoading(false);}}).catch(e=>{if(!controller.signal.aborted){setError(friendlyError(e));setLoading(false);}});return()=>controller.abort();},[canManage,tenant?.id]);
 if(!session)return <Alert type="info" title="登录后查看组织审批。"/>;
 if(!canManage)return <Alert type="info" title="请选择组织。审批权限仅授予组织所有者和管理员。"/>;
 async function decide(action:'approve'|'reject'){
  if(!detail||busy)return;setBusy(true);setError('');
  try{await approvalRequest(`/api/approvals/${detail.id}/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reason})});setDecidedRun(detail.run_id);setDetail(undefined);await load();}
  catch(e){setError(friendlyError(e));await load();}finally{setBusy(false);}
 }
 return <section className="surface" style={{padding:24}}><Space orientation="vertical" style={{width:'100%'}} size="large">
  <div><Typography.Title level={2}>人工审批</Typography.Title><Typography.Paragraph type="secondary">查看工具调用、核对脱敏参数，再决定是否允许继续。高风险操作需要其他管理员批准。</Typography.Paragraph><Button loading={loading} onClick={()=>void load()}>刷新列表</Button></div>
  {decidedRun&&<Alert type="success" title="审批已处理" description={<Link href={`/agent?run=${decidedRun}`}>返回原聊天，查看执行进度与回答</Link>}/>}
  {error&&<Alert type="error" title={error} closable onClose={()=>setError('')}/>}
  <Table<Approval> rowKey="id" dataSource={rows} loading={loading} locale={{emptyText:<Empty description="暂无审批请求"/>}} scroll={{x:800}} columns={[
   {title:'工具',dataIndex:'tool_name'}, {title:'风险',dataIndex:'risk_level',render:v=><Tag color={v==='high'?'red':'blue'}>{v==='high'?'高风险':'低风险'}</Tag>},
   {title:'状态',dataIndex:'status',filters:Object.entries(labels).map(([value,text])=>({value,text})),onFilter:(v,r)=>r.status===v,render:v=>labels[v]??v},
   {title:'请求人',dataIndex:'requested_by_user_id'},{title:'请求时间',dataIndex:'requested_at',render:v=>new Date(v).toLocaleString()},
   {title:'操作',render:(_,r)=><Space><Link href={`/agent?run=${r.run_id}`}>查看原聊天</Link><Button onClick={async()=>{setReason('');try{const {approval}=await approvalRequest<{approval:Approval}>(`/api/approvals/${r.id}`);setDetail(approval);}catch(e){setError(friendlyError(e));}}}>查看详情</Button></Space>}
  ]}/>
 </Space><Drawer title="审批详情" open={!!detail} onClose={()=>{if(!busy)setDetail(undefined);}} size="large">{detail&&<Space orientation="vertical" style={{width:'100%'}} size="large">
  <Link href={`/agent?run=${detail.run_id}`}>查看原聊天</Link><Descriptions column={1} items={[
   {key:'tool',label:'工具',children:detail.tool_name},{key:'risk',label:'风险',children:detail.risk_level==='high'?'高风险':'低风险'},
   {key:'status',label:'状态',children:labels[detail.status]},{key:'requester',label:'请求人',children:detail.requested_by_user_id},
   {key:'time',label:'请求时间',children:new Date(detail.requested_at).toLocaleString()}, {key:'expiry',label:'过期时间',children:new Date(detail.expires_at).toLocaleString()},
   {key:'run',label:'Run',children:<Typography.Text copyable>{detail.run_id}</Typography.Text>}
  ]}/><div><Typography.Title level={5}>脱敏参数</Typography.Title><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(detail.display_arguments,null,2)}</pre></div>
  {detail.status==='pending'?<><label htmlFor="approval-reason">决策原因（最多 500 字，请勿填写敏感信息）</label><Input.TextArea id="approval-reason" maxLength={500} value={reason} onChange={e=>setReason(e.target.value)} disabled={busy}/><Space><Button type="primary" loading={busy} disabled={detail.risk_level==='high'&&detail.requested_by_user_id===session.user.id} onClick={()=>void decide('approve')}>批准并继续</Button><Button danger disabled={busy} onClick={()=>void decide('reject')}>拒绝</Button></Space></>:<Typography.Paragraph>决策原因：{detail.decision_reason||'未填写'}</Typography.Paragraph>}
 </Space>}</Drawer></section>;
}
