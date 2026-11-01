"use client";
import { useEffect, useState } from 'react';
import { Alert, Button, Select, Space } from 'antd';
import { useRouter } from 'next/navigation';
import { useWorkspace } from './workspace-provider';
import { ChatPanel } from './chat-panel';
import { responseError, friendlyError } from '@/lib/ui-errors';
type Run={id:string;title:string;status:string;created_at:string};
const statuses:Record<string,string>={pending:'排队中',running:'执行中',waiting_approval:'待审批',completed:'已完成',failed:'失败',cancelled:'已取消',interrupted:'已中断'};
export function AgentHistory({runId}:{runId?:string}){
 const {session,tenant}=useWorkspace();const router=useRouter();const userId=session?.user.id,tenantId=tenant?.id;
 const [newChatVersion,setNewChatVersion]=useState(0);
 const [runs,setRuns]=useState<Run[]>([]),[error,setError]=useState('');
 useEffect(()=>{
  if(!userId||!tenantId)return;const controller=new AbortController();
  fetch('/api/agent/runs',{signal:controller.signal}).then(async response=>{if(!response.ok)throw new Error(await responseError(response));return response.json() as Promise<{runs:Run[]}>;})
   .then(data=>{if(!controller.signal.aborted){setRuns(data.runs);setError('');}}).catch(e=>{if(!controller.signal.aborted)setError(friendlyError(e));});
  return()=>controller.abort();
 },[userId,tenantId,runId]);
 return <><Space wrap style={{marginBottom:16,width:'100%'}}><Select aria-label="历史 Agent 会话" placeholder="找回历史聊天（最近 50 个后台任务）" value={runId} style={{width:360,maxWidth:'100%'}} showSearch optionFilterProp="label" options={runs.map(run=>({value:run.id,label:`${run.title} · ${statuses[run.status]??run.status} · ${new Date(run.created_at).toLocaleString()}`}))} onChange={id=>router.push(`/agent?run=${encodeURIComponent(id)}`)}/><Button onClick={()=>{setNewChatVersion(v=>v+1);router.push("/agent");}}>新会话</Button></Space>{error&&<Alert type="warning" title={error}/>}<ChatPanel key={`${tenantId??''}:${runId??'new'}:${newChatVersion}`} endpoint="/api/agent/stream" initialRunId={runId}/></>;
}
