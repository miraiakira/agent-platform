import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { RunnerCheckpoint } from '@eap/ai';
import { estimateCost, metric, log } from '@eap/observability';
import { SecurityError, SecurityStore, type ToolPolicy, type Role, rolePermissions } from './security';
import { securityContext } from './security-context';
import { transaction, lockLease, insertEvent } from './transaction';
import type { ClaimedJob } from './job-queue';
import { argumentsHash, digest, seal, unseal, displayArguments } from './approval-crypto';
export interface ApprovalGrant { id:string; jobId:string; leaseToken:string; callId:string; checkpointVersion:number; hash:string }
interface Approval {
 id:string;tenant_id:string;run_id:string;job_id:string;checkpoint_id:string;checkpoint_version:number;
 tool_call_id:string;tool_name:string;tool_arguments:unknown;tool_arguments_hash:string;display_arguments:unknown;
 requested_by_user_id:string;status:string;requested_at:Date;expires_at:Date;policy_version:number;risk_level:string;consumed_by_lease:string|null;
}
const columns='id,run_id,job_id,tool_call_id,tool_name,display_arguments,risk_level,requested_by_user_id,status,requested_at,expires_at,decided_by_user_id,decided_at,decision_reason,checkpoint_version,policy_version';
const aad=(a:Pick<Approval,'tenant_id'|'run_id'|'job_id'|'id'|'checkpoint_version'>)=>[a.tenant_id,a.run_id,a.job_id,a.id,a.checkpoint_version].join(':');
export class ApprovalStore {
 readonly security:SecurityStore;
 constructor(readonly db:Pool){this.security=new SecurityStore(db);}
 private async transact<T>(fn:(c:PoolClient)=>Promise<T>):Promise<T>{
  try{return await transaction(this.db,fn);}catch(error){if(error instanceof SecurityError)throw error;const code=(error as {code?:string})?.code;if(code==='P1002')throw new SecurityError(410,'APPROVAL_EXPIRED');throw new SecurityError(503,code==='P1001'?'AUDIT_UNAVAILABLE':'APPROVAL_UNAVAILABLE');}
 }
 async list(id?:string){await this.security.authorize('approval:read');return (await this.db.query(`SELECT ${columns} FROM agent_approvals WHERE tenant_id=$1${id?' AND id=$2':''} ORDER BY (status='pending') DESC,requested_at DESC LIMIT 100`,id?[securityContext()?.tenantId,id]:[securityContext()?.tenantId])).rows;}
 async policy(name:string,c:Pool|PoolClient=this.db,actor=securityContext()?.actorUserId):Promise<ToolPolicy>{
  let row:ToolPolicy & {actor_role:Role|null}|undefined;
  try {row=(await c.query<ToolPolicy & {actor_role:Role|null}>('SELECT p.*,eap_role($1,$2) AS actor_role FROM tenant_tool_policies p WHERE tenant_id=$1 AND tool_name=$3',[securityContext()?.tenantId,actor,name])).rows[0];}
  catch {throw new SecurityError(503,'AUTHORIZATION_UNAVAILABLE');}
  if(!row?.actor_role || !rolePermissions[row.actor_role].includes('tool:execute') || !row.enabled || !row.allowed_roles.includes(row.actor_role)) throw new SecurityError(403,'TOOL_FORBIDDEN');
  return row;
 }
 private async decode(a:Approval,c:Pool|PoolClient=this.db):Promise<RunnerCheckpoint>{
  const cp=(await c.query('SELECT * FROM agent_checkpoints WHERE id=$1 AND tenant_id=$2',[a.checkpoint_id,a.tenant_id])).rows[0];
  if(!cp || cp.format_version!==1 || cp.checkpoint_version!==a.checkpoint_version || cp.run_id!==a.run_id || cp.job_id!==a.job_id || cp.approval_id!==a.id || cp.pending_tool_call_hash!==a.tool_arguments_hash) throw new SecurityError(409,'CHECKPOINT_MISMATCH');
  let state:RunnerCheckpoint;let args:unknown;let pending:unknown;
  try {state=unseal<RunnerCheckpoint>(cp.runner_state,aad(a));args=unseal(a.tool_arguments,aad(a));pending=unseal(cp.pending_tool_call,aad(a));}
  catch {throw new SecurityError(409,'CHECKPOINT_MISMATCH');}
  const call=state.batch?.calls[state.batch.nextIndex];
  if(state.version!==1 || digest(state)!==cp.state_hash || !call || call.id!==a.tool_call_id || call.function.name!==a.tool_name || argumentsHash(call.function.arguments)!==a.tool_arguments_hash || digest(args)!==a.tool_arguments_hash || digest(pending)!==digest(call)) throw new SecurityError(409,'CHECKPOINT_MISMATCH');
  // Every completed tool result must still have a conclusive ledger entry. UNKNOWN never resumes.
  const ledger=(await c.query('SELECT tool_call_id,tool_name,status,output FROM tool_executions WHERE run_id=$1',[a.run_id])).rows;
  if(ledger.some(r=>!['succeeded','failed'].includes(r.status))) throw new SecurityError(409,'TOOL_REPLAY_BLOCKED');
  for(const m of state.history){if(m.role==='tool'){
   const entry=ledger.find(r=>r.tool_call_id===m.tool_call_id);
   if(!entry || entry.output!==m.content) throw new SecurityError(409,'CHECKPOINT_LEDGER_MISMATCH');
  }}
  const prefix=state.batch.calls.slice(0,state.batch.nextIndex);
  if(prefix.some(call=>!ledger.some(r=>r.tool_call_id===call.id&&r.tool_name===call.function.name))) throw new SecurityError(409,'CHECKPOINT_LEDGER_MISMATCH');
  return state;
 }
 async pause(job:ClaimedJob,state:RunnerCheckpoint,ttlSeconds=3600,signal?:AbortSignal){
  const started=performance.now();
  const checkAbort=()=>{if(signal?.aborted)throw new SecurityError(409,(signal.reason as {code?:string})?.code??'CANCELLED');};
  const a=await this.transact(async c=>{
   const locked=await lockLease(c,job.id,job.lease_token);checkAbort();if(!locked || locked.cancel_requested_at) throw new SecurityError(409,'LEASE_LOST');
   const call=state.batch.calls[state.batch.nextIndex];if(!call) throw new SecurityError(409,'CHECKPOINT_MISMATCH');
   const policy=await this.policy(call.function.name,c);if(!policy.requires_approval) return null;
   if((await c.query("SELECT 1 FROM tool_executions WHERE run_id=$1 AND status NOT IN ('succeeded','failed')",[job.run_id])).rowCount) throw new SecurityError(409,'TOOL_REPLAY_BLOCKED');
   state.elapsedActiveMs+=performance.now()-started;
   const id=randomUUID(),cpId=randomUUID(),version=(locked.checkpoint_version??0)+1;
   const binding={tenant_id:job.tenant_id!,run_id:job.run_id,job_id:job.id,id,checkpoint_version:version};
   const hash=argumentsHash(call.function.arguments),ctx=aad(binding);
   await c.query(`INSERT INTO agent_checkpoints(id,tenant_id,run_id,job_id,approval_id,checkpoint_version,runner_state,state_hash,pending_tool_call,pending_tool_call_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10)`,[cpId,job.tenant_id,job.run_id,job.id,id,version,JSON.stringify(seal(state,ctx)),digest(state),JSON.stringify(seal(call,ctx)),hash]);
   await c.query(`INSERT INTO agent_approvals(id,tenant_id,run_id,job_id,checkpoint_id,checkpoint_version,tool_call_id,tool_name,tool_arguments,tool_arguments_hash,display_arguments,risk_level,requested_by_user_id,expires_at,policy_version)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12,$13,clock_timestamp()+$14*interval '1 second',$15)`,[id,job.tenant_id,job.run_id,job.id,cpId,version,call.id,call.function.name,JSON.stringify(seal(JSON.parse(call.function.arguments),ctx)),hash,JSON.stringify(displayArguments(call.function.name,call.function.arguments)),policy.risk_level,job.actor_user_id,ttlSeconds,policy.policy_version]);
   const t=state.trace;
   for(const [index,span] of t.spans.entries()) await c.query(`INSERT INTO trace_spans(id,tenant_id,run_id,span_index,name,kind,status,duration_ms,data)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT(run_id,span_index) DO NOTHING`,[randomUUID(),job.tenant_id,job.run_id,index,span.name,span.kind,span.success?'success':'error',Math.round(span.durationMs),JSON.stringify(span)]);
   const cost=estimateCost(state.provider,state.model,t.usage.inputTokens,t.usage.outputTokens,new Date(t.startedAt));
   await c.query(`UPDATE agent_runs SET status='waiting_approval',trace_id=$2,model_calls=$3,tool_calls=$4,input_tokens=$5,output_tokens=$6,observability=$7::jsonb WHERE id=$1`,[job.run_id,t.traceId,t.modelCalls,t.toolCalls,t.usage.inputTokens,t.usage.outputTokens,JSON.stringify({provider:state.provider,model:state.model,usageSource:t.usageReports===t.modelCalls?'reported':t.usageReports?'partial':'unavailable',cost:{...cost,...(!t.usageReports?{usd:null}:{})}})]);
   checkAbort();
   const changed=await c.query(`UPDATE agent_jobs SET status='waiting_approval',worker_id=NULL,lease_token=NULL,lease_expires_at=NULL,active_approval_id=$3,checkpoint_version=$4 WHERE id=$1 AND lease_token=$2 AND lease_expires_at>clock_timestamp() AND cancel_requested_at IS NULL`,[job.id,job.lease_token,id,version]);
   if(changed.rowCount!==1) throw new SecurityError(409,'LEASE_LOST');return id;
  });
  if(a) metric('agent_approvals_requested_total',1);return a;
 }
 async resume(job:ClaimedJob):Promise<{state:RunnerCheckpoint;grant:ApprovalGrant}|null>{
  if(!job.active_approval_id) return null;
  try{return await this.transact(async c=>{
   if(!await lockLease(c,job.id,job.lease_token)) throw new SecurityError(409,'LEASE_LOST');
   const a=(await c.query<Approval>('SELECT * FROM agent_approvals WHERE id=$1 FOR UPDATE',[job.active_approval_id])).rows[0];
   if(!a || a.job_id!==job.id || a.run_id!==job.run_id || a.tenant_id!==job.tenant_id || a.requested_by_user_id!==job.actor_user_id || a.checkpoint_version!==job.checkpoint_version || a.status!=='approved' || a.consumed_by_lease || new Date(a.expires_at).getTime()<=Date.now()) throw new SecurityError(409,'APPROVAL_INVALID');
   const state=await this.decode(a,c),policy=await this.policy(a.tool_name,c);
   if(policy.policy_version!==a.policy_version) throw new SecurityError(409,'APPROVAL_POLICY_CHANGED');
   await this.security.audit('approval.execution_resumed','approval',a.id,'allow','APPROVAL_VALID',c);
   await insertEvent(c,job.run_id,'approval',{type:'approval',approvalId:a.id,status:'resumed',toolName:a.tool_name});
   return {state,grant:{id:a.id,jobId:job.id,leaseToken:job.lease_token,callId:a.tool_call_id,checkpointVersion:a.checkpoint_version,hash:a.tool_arguments_hash}};
  });}catch(error){
   await this.security.audit('approval.execution_denied','approval',job.active_approval_id,'deny',error instanceof SecurityError?error.code:'APPROVAL_UNAVAILABLE').catch(()=>log('error','security.audit_unavailable',{error_code:'AUDIT_UNAVAILABLE'}));throw error;
  }
 }
 async decide(id:string,decision:'approved'|'rejected',reason:string){
  const result=await this.transact(async c=>{
   const ctx=securityContext()!;
   await c.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[ctx.tenantId]);
   await this.security.authorize('approval:decide',c);
   const first=(await c.query<Approval>('SELECT * FROM agent_approvals WHERE id=$1',[id])).rows[0];if(!first) throw new SecurityError(404,'NOT_FOUND');
   await c.query('SELECT id FROM agent_jobs WHERE id=$1 FOR UPDATE',[first.job_id]);await c.query('SELECT id FROM agent_runs WHERE id=$1 FOR UPDATE',[first.run_id]);
   const a=(await c.query<Approval>('SELECT * FROM agent_approvals WHERE id=$1 FOR UPDATE',[id])).rows[0]!;
   if(a.status==='expired') throw new SecurityError(410,'APPROVAL_EXPIRED');
   if(a.status!=='pending') throw new SecurityError(409,'APPROVAL_ALREADY_DECIDED');
   if(new Date(a.expires_at).getTime()<=Date.now()){
    await c.query("UPDATE agent_approvals SET status='expired',decided_at=clock_timestamp(),decision_reason='Deadline reached' WHERE id=$1",[id]);return {expired:true,wait:(Date.now()-new Date(a.requested_at).getTime())/1000};
   }
   if(decision==='approved'){
    if(a.risk_level==='high'&&ctx.actorUserId===a.requested_by_user_id) throw new SecurityError(403,'SELF_APPROVAL_FORBIDDEN');
    const policy=await this.policy(a.tool_name,c,a.requested_by_user_id);if(policy.policy_version!==a.policy_version) throw new SecurityError(409,'APPROVAL_POLICY_CHANGED');await this.decode(a,c);
   }
   await c.query('UPDATE agent_approvals SET status=$2,decided_by_user_id=$3,decided_at=clock_timestamp(),decision_reason=$4 WHERE id=$1',[id,decision,ctx.actorUserId,reason]);return {expired:false,wait:(Date.now()-new Date(a.requested_at).getTime())/1000};
  });
  metric('agent_approvals_decided_total',1,{status:result.expired?'expired':decision});metric('agent_approval_wait_duration_seconds',result.wait);
  if(result.expired) throw new SecurityError(410,'APPROVAL_EXPIRED');
 }
 async expire(){metric('agent_approvals_pending',Number((await this.db.query('SELECT eap_pending_approval_count() AS count')).rows[0].count));const rows=(await this.db.query<{wait_seconds:number}>('SELECT * FROM eap_expire_approvals()')).rows;for(const r of rows){metric('agent_approvals_decided_total',1,{status:'expired'});metric('agent_approval_wait_duration_seconds',r.wait_seconds);}return rows.length;}
}
