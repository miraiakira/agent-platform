import { responseError } from './ui-errors';
import { subscribeRun } from './async-agent-client';
export interface PersistedToolActivity {
 id:string;name:string;status:'running'|'success'|'error'|'interrupted';
}
/** Reconstruct display-only tool activity from committed events; never execute tools on restore. */
export async function loadPersistedToolActivities(runId:string,signal:AbortSignal):Promise<PersistedToolActivity[]>{
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId))throw new Error('INVALID_RUN_ID');
 const activities=new Map<string,PersistedToolActivity>();
 for await(const event of subscribeRun(`/api/agent/runs/${runId}/events`,signal)){
  if(event.type==='tool-start')activities.set(event.toolCallId,{id:event.toolCallId,name:event.toolName,status:'running'});
  if(event.type==='tool-result')activities.set(event.toolCallId,{id:event.toolCallId,name:event.toolName,status:event.success?'success':'error'});
 }
 return [...activities.values()].map(activity=>activity.status==='running'?{...activity,status:'interrupted'}:activity);
}
export interface RestoredRun {
 id:string;conversation_id:string;status:string;trace_id:string;model_calls:number;
 input:unknown;output:unknown;error:{code?:string;message?:string}|null;
 input_tokens:number;output_tokens:number;
 observability?:{cost?:{usd:number|null};usageSource?:string}|null;
}
/** Load server-owned messages only; never POST a replacement job or store chat text in localStorage. */
export async function loadPersistedAgentChat(runId:string,signal:AbortSignal){
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId))throw new Error('INVALID_RUN_ID');
 const response=await fetch(`/api/agent/runs/${runId}`,{signal,cache:'no-store'});
 if(!response.ok)throw new Error(await responseError(response));
 const {run}=await response.json() as {run:RestoredRun};
 if(run.id!==runId||!Array.isArray(run.input))throw new Error('INVALID_RUN_DATA');
 const messages: Array<{role:'user'|'assistant';content:string}>=[];
 for(const value of run.input){if(value&&typeof value==='object'&&['user','assistant'].includes(value.role)&&typeof value.content==='string')messages.push({role:value.role,content:value.content});}
 const answer=run.output&&typeof run.output==='object'&&'answer' in run.output&&typeof run.output.answer==='string'?run.output.answer:'';
 return {run,messages,answer};
}
