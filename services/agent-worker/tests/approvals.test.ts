import { beforeEach,afterEach,describe,it,expect,vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { MockProvider, type ModelToolStreamEvent, type StreamWithToolsOptions } from '@eap/ai';
import { z } from 'zod';
import { ToolRegistry } from '@eap/tools';
import { ApprovalStore,SecurityStore,JobLifecycle,AgentJobQueue,AgentEventStore,PersistenceStore,withSecurityContext,type ClaimedJob } from '@eap/persistence';
import { securityDatabase } from '../../../packages/persistence/tests/security-database';
import { AgentExecutor } from '../src/executor';
import { runWorker } from '../src/worker';
class BatchProvider extends MockProvider {
 calls=0;
 async *streamWithTools(options:StreamWithToolsOptions):AsyncIterable<ModelToolStreamEvent>{
  this.calls++;
  if(this.calls===1){for(const [index,name] of ['a','get_high_risk_transactions','c'].entries())yield {type:'tool-call-delta',index,id:name,name,arguments:'{"limit":1,"date":"2026-11-01","secret":"never-log-me"}'};yield {type:'usage',usage:{inputTokens:10,outputTokens:5,totalTokens:15}};yield {type:'model-finish',finishReason:'tool_calls'};}
  else {void options;yield {type:'model-finish',finishReason:'stop'};}
 }
}
describe('durable approval under real restricted PostgreSQL roles',()=>{
 let db:Awaited<ReturnType<typeof securityDatabase>>,tenant:string,other:string,security:SecurityStore,approvals:ApprovalStore,appApprovals:ApprovalStore,queue:AgentJobQueue,lifecycle:JobLifecycle,store:PersistenceStore,events:AgentEventStore,job:ClaimedJob,runId:string;
 let executed:string[],provider:BatchProvider,tools:ToolRegistry;
 const as=<T>(actor:string,fn:()=>T,t=tenant)=>withSecurityContext({tenantId:t,actorUserId:actor},fn);
 beforeEach(async()=>{
  vi.stubEnv('AGENT_CHECKPOINT_KEY','11'.repeat(32));db=await securityDatabase();security=new SecurityStore(db.app);approvals=new ApprovalStore(db.worker);appApprovals=new ApprovalStore(db.app);
  for(const user of ['alice','admin','member','bob'])await db.auth.query('INSERT INTO "user"(id,name,email) VALUES($1,$1,$2)',[user,`${user}@test.local`]);
  tenant=(await withSecurityContext({actorUserId:'alice'},()=>security.createTenant('A'))).id;other=(await withSecurityContext({actorUserId:'bob'},()=>security.createTenant('B'))).id;
  await as('alice',()=>security.changeMember('admin','admin','active'));await as('alice',()=>security.changeMember('member','member','active'));
  await as('alice',()=>security.setPolicy({tool_name:'get_high_risk_transactions',enabled:true,allowed_roles:['owner','admin','member'],risk_level:'high',requires_approval:true}));
  for(const name of ['a','c'])await db.admin.query("INSERT INTO tenant_tool_policies(tenant_id,tool_name,enabled,allowed_roles,risk_level,requires_approval) VALUES($1,$2,true,ARRAY['owner','member'],'low',false)",[tenant,name]);
  queue=new AgentJobQueue(db.worker,true);lifecycle=new JobLifecycle(db.worker,new SecurityStore(db.worker));store=new PersistenceStore(db.worker);events=new AgentEventStore(db.worker);
  const run=await as('member',()=>new JobLifecycle(db.app,security).submit({requestKey:randomUUID(),messages:[{role:'user',content:'test'}]}));runId=run.id;job=(await queue.claim('worker-before',10))!;
  executed=[];provider=new BatchProvider();tools=new ToolRegistry((name,args,ctx)=>new SecurityStore(db.worker).authorizeTool(name,args,ctx));
  for(const name of ['a','get_high_risk_transactions','c'])tools.register({name,description:name,parameters:{type:'object'},schema:z.object({limit:z.number(),date:z.string(),secret:z.string()}),async execute(){executed.push(name);return {ok:true};}});
 });
 afterEach(async()=>{await db?.close();vi.unstubAllEnvs();});
 function executor(){return new AgentExecutor({store,events,lifecycle,security:new SecurityStore(db.worker),approvals,provider,tools});}
 async function pause(){const result=await as('member',()=>executor().execute(job,new AbortController().signal));expect(result.status,JSON.stringify(result)).toBe('waiting_approval');return (await as('alice',()=>appApprovals.list()))[0]!;}
 async function resume(){const next=(await queue.claim('worker-after',10))!;const result=await as('member',()=>executor().execute(next,new AbortController().signal));if(result.status!=='waiting_approval')expect(await as('member',()=>lifecycle.finalizeJob({...result,jobId:next.id,leaseToken:next.lease_token}))).toBe(true);return result;}
 it('pauses without lease, encrypts immutable state, resumes after Worker restart without replaying A or recounting usage',async()=>{
  const a=await pause();expect(executed).toEqual(['a']);const waiting=(await db.admin.query('SELECT * FROM agent_jobs WHERE id=$1',[job.id])).rows[0];expect(waiting.status).toBe('waiting_approval');expect(waiting.lease_token).toBeNull();expect(await queue.claim('idle')).toBeNull();
  const cp=(await db.admin.query('SELECT * FROM agent_checkpoints')).rows[0];expect(JSON.stringify(cp)).not.toContain('never-log-me');
  await expect(db.admin.query("UPDATE agent_checkpoints SET state_hash=repeat('0',64)")).rejects.toThrow('immutable');
  await as('admin',()=>appApprovals.decide(a.id,'approved','checked'));
  const claims=await Promise.all([queue.claim('new-1'),queue.claim('new-2')]);expect(claims.filter(Boolean)).toHaveLength(1);const next=claims.find(Boolean)!;
  const result=await as('member',()=>executor().execute(next,new AbortController().signal));expect(result.status).toBe('completed');expect(executed).toEqual(['a','get_high_risk_transactions','c']);expect(provider.calls).toBe(2);
  expect(await as('member',()=>lifecycle.finalizeJob({...result,jobId:next.id,leaseToken:next.lease_token}))).toBe(true);
  const run=(await db.admin.query('SELECT * FROM agent_runs WHERE id=$1',[runId])).rows[0];expect(run.tool_calls).toBe(3);expect(run.model_calls).toBe(3);expect(Number(run.input_tokens)).toBe(10);expect(Number(run.output_tokens)).toBe(5);
  expect((await db.admin.query('SELECT count(*)::int AS count FROM tool_executions WHERE run_id=$1',[runId])).rows[0].count).toBe(3);
  expect((await db.admin.query('SELECT count(*)::int AS count FROM agent_usage WHERE run_id=$1',[runId])).rows[0].count).toBe(1);
  const data=await as('alice',()=>new AgentEventStore(db.app).listAfter(runId,'0'));expect(JSON.stringify(data)).not.toContain('never-log-me');expect(data.filter(e=>e.event_type==='approval').map(e=>(e.payload as {status:string}).status)).toEqual(['waiting_approval','approved','resumed']);
 });
 it('rejects once and terminates without executing pending effects',async()=>{const a=await pause();await as('admin',()=>appApprovals.decide(a.id,'rejected','no'));expect(await queue.claim('no')).toBeNull();expect(executed).toEqual(['a']);await expect(as('admin',()=>appApprovals.decide(a.id,'approved',''))).rejects.toMatchObject({code:'APPROVAL_ALREADY_DECIDED'});});
 it('serializes concurrent approve and reject',async()=>{const a=await pause();const outcomes=await Promise.allSettled([as('admin',()=>appApprovals.decide(a.id,'approved','')),as('admin',()=>appApprovals.decide(a.id,'rejected',''))]);expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);});
 it('hides cross-tenant requests, denies Member and rechecks approver membership',async()=>{const a=await pause();expect(await as('bob',()=>appApprovals.list(a.id),other)).toEqual([]);expect((await as('bob',()=>db.app.query('SELECT id FROM agent_approvals WHERE id=$1',[a.id]),other)).rows).toEqual([]);expect((await db.app.query('SELECT id FROM agent_checkpoints')).rows).toEqual([]);await expect(as('bob',()=>appApprovals.decide(a.id,'approved',''),other)).rejects.toMatchObject({status:404});await expect(as('member',()=>appApprovals.decide(a.id,'approved',''))).rejects.toMatchObject({status:403});await as('alice',()=>security.changeMember('admin','admin','removed'));await expect(as('admin',()=>appApprovals.decide(a.id,'approved',''))).rejects.toMatchObject({status:403});});
 it('checks actor revocation and policy version before resume',async()=>{const a=await pause();await as('admin',()=>appApprovals.decide(a.id,'approved',''));await as('alice',()=>security.setPolicy({tool_name:'get_high_risk_transactions',enabled:false,allowed_roles:['member'],risk_level:'high',requires_approval:true}));await expect(resume()).rejects.toMatchObject({code:'TOOL_FORBIDDEN'});expect(executed).toEqual(['a']);const current=(await db.admin.query('SELECT lease_token FROM agent_jobs WHERE id=$1',[job.id])).rows[0];
  expect(await as('member',()=>lifecycle.finalizeJob({jobId:job.id,leaseToken:current.lease_token,status:'failed',error:{code:'TOOL_FORBIDDEN',message:'denied'}}))).toBe(true);
  const usage=(await db.admin.query('SELECT input_tokens FROM agent_usage WHERE run_id=$1',[runId])).rows[0];expect(Number(usage.input_tokens)).toBe(10);expect((await db.admin.query('SELECT model_calls FROM agent_runs WHERE id=$1',[runId])).rows[0].model_calls).toBe(1);});
 it('refuses a changed policy even if still enabled',async()=>{const a=await pause();await as('admin',()=>appApprovals.decide(a.id,'approved',''));await as('alice',()=>security.setPolicy({tool_name:'get_high_risk_transactions',enabled:true,allowed_roles:['member'],risk_level:'high',requires_approval:true}));await expect(resume()).rejects.toMatchObject({code:'APPROVAL_POLICY_CHANGED'});});
 it('atomically cancels waiting request and blocks future decisions',async()=>{const a=await pause();expect(await as('member',()=>new AgentJobQueue(db.app).requestCancellation(runId))).toBe(true);expect((await db.admin.query('SELECT status FROM agent_approvals WHERE id=$1',[a.id])).rows[0].status).toBe('cancelled');expect(await queue.claim('none')).toBeNull();});
 it('persistent expiry scan terminates orphaned waiting work after a restart',async()=>{
  const original=approvals.pause.bind(approvals);vi.spyOn(approvals,'pause').mockImplementation((j,s)=>original(j,s,0.02));const a=await pause();await new Promise(r=>setTimeout(r,35));expect(await new ApprovalStore(db.worker).expire()).toBe(1);await expect(as('admin',()=>appApprovals.decide(a.id,'approved',''))).rejects.toMatchObject({status:410});expect(await queue.claim('none')).toBeNull();
 });
 it('returns explicit expiry on decision and commits terminal state',async()=>{const original=approvals.pause.bind(approvals);vi.spyOn(approvals,'pause').mockImplementation((j,s)=>original(j,s,0.02));const a=await pause();await new Promise(r=>setTimeout(r,35));await expect(as('admin',()=>appApprovals.decide(a.id,'approved',''))).rejects.toMatchObject({status:410});expect((await db.admin.query('SELECT status FROM agent_jobs WHERE id=$1',[job.id])).rows[0].status).toBe('failed');});
 it('audit write failure rolls back approval decision and prevents downstream execution',async()=>{const a=await pause();await db.admin.query(`CREATE FUNCTION fail_approval_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='approval.approved' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$`);await db.admin.query('CREATE TRIGGER fault BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_approval_audit()');await expect(as('admin',()=>appApprovals.decide(a.id,'approved',''))).rejects.toThrow();expect(await queue.claim('none')).toBeNull();expect(executed).toEqual(['a']);expect((await db.admin.query('SELECT status FROM agent_approvals WHERE id=$1',[a.id])).rows[0].status).toBe('pending');});
 it('UNKNOWN ledger blocks resume and approval cannot alter canonical arguments',async()=>{const a=await pause();await expect(as('admin',()=>db.app.query("UPDATE agent_approvals SET tool_arguments_hash=repeat('0',64) WHERE id=$1",[a.id]))).rejects.toThrow('immutable');await db.admin.query("UPDATE tool_executions SET status='unknown' WHERE run_id=$1",[runId]);await expect(as('admin',()=>appApprovals.decide(a.id,'approved',''))).rejects.toMatchObject({code:'TOOL_REPLAY_BLOCKED'});});
 it('handles two approval checkpoints within one model batch without replay',async()=>{
  await db.admin.query("UPDATE tenant_tool_policies SET requires_approval=true WHERE tenant_id=$1 AND tool_name='c'",[tenant]);
  const first=await pause();await as('admin',()=>appApprovals.decide(first.id,'approved',''));
  expect((await resume()).status).toBe('waiting_approval');expect(executed).toEqual(['a','get_high_risk_transactions']);
  const all=await as('admin',()=>appApprovals.list());const second=all.find(a=>a.status==='pending')!;expect(second.checkpoint_version).toBe(2);
  await as('admin',()=>appApprovals.decide(second.id,'approved',''));expect((await resume()).status).toBe('completed');expect(executed).toEqual(['a','get_high_risk_transactions','c']);expect(provider.calls).toBe(2);
 });
 it('fails closed on checkpoint version conflict',async()=>{
  const a=await pause();await as('admin',()=>appApprovals.decide(a.id,'approved',''));
  await db.admin.query('UPDATE agent_jobs SET checkpoint_version=checkpoint_version+1 WHERE id=$1',[job.id]);await expect(resume()).rejects.toMatchObject({code:'APPROVAL_INVALID'});expect(executed).toEqual(['a']);
 });
 it('validates the canonical arguments hash even after privileged encrypted-payload corruption',async()=>{
  const a=await pause();
  const {seal}=await import('../../../packages/persistence/src/approval-crypto');
  const row=(await db.admin.query('SELECT * FROM agent_approvals WHERE id=$1',[a.id])).rows[0];
  const binding=[row.tenant_id,row.run_id,row.job_id,row.id,row.checkpoint_version].join(':');
  await db.admin.query('ALTER TABLE agent_approvals DISABLE TRIGGER immutable_approval');
  await db.admin.query('UPDATE agent_approvals SET tool_arguments=$2::jsonb WHERE id=$1',[a.id,JSON.stringify(seal({forged:true},binding))]);
  await db.admin.query('ALTER TABLE agent_approvals ENABLE TRIGGER immutable_approval');
  await expect(as('admin',()=>appApprovals.decide(a.id,'approved',''))).rejects.toMatchObject({code:'CHECKPOINT_MISMATCH'});expect(executed).toEqual(['a']);
 });
 it('revalidates removed actor after approval',async()=>{
  const a=await pause();await as('admin',()=>appApprovals.decide(a.id,'approved',''));
  await as('alice',()=>security.changeMember('member','member','removed'));await expect(resume()).rejects.toMatchObject({status:403});expect(executed).toEqual(['a']);expect((await db.admin.query("SELECT event_id FROM audit_logs WHERE action='approval.execution_denied'")).rowCount).toBeGreaterThan(0);
 });
 it('denies an already approved tool after the tenant is disabled, without losing usage',async()=>{
  const approval=await pause();await as('admin',()=>appApprovals.decide(approval.id,'approved','checked'));
  await as('alice',()=>security.setTenant('disabled'));
  await expect(resume()).rejects.toMatchObject({status:403,code:'FORBIDDEN'});
  expect(executed).toEqual(['a']);expect(provider.calls).toBe(1);
  const current=(await db.admin.query('SELECT lease_token FROM agent_jobs WHERE id=$1',[job.id])).rows[0];
  expect(await as('member',()=>lifecycle.finalizeJob({jobId:job.id,leaseToken:current.lease_token,status:'failed',error:{code:'FORBIDDEN',message:'Tenant disabled'}}))).toBe(true);
  expect((await db.admin.query("SELECT event_id FROM audit_logs WHERE action='approval.execution_denied' AND resource_id=$1",[approval.id])).rowCount).toBe(1);
  expect((await db.admin.query('SELECT status FROM agent_jobs WHERE id=$1',[job.id])).rows[0].status).toBe('failed');
  expect(Number((await db.admin.query('SELECT input_tokens FROM agent_usage WHERE run_id=$1',[runId])).rows[0].input_tokens)).toBe(10);
  expect((await db.admin.query('SELECT * FROM tool_executions WHERE run_id=$1',[runId])).rows).toHaveLength(1);
 });
 it('cancellation racing approval produces no tool effect and one decision',async()=>{
  const a=await pause();await Promise.allSettled([as('admin',()=>appApprovals.decide(a.id,'approved','')),as('member',()=>new AgentJobQueue(db.app).requestCancellation(runId))]);
  expect(await queue.claim('no-effects')).toBeNull();expect(executed).toEqual(['a']);
  const current=(await db.admin.query('SELECT status FROM agent_approvals WHERE id=$1',[a.id])).rows[0];expect(['approved','cancelled']).toContain(current.status);
 });
 it('a promoted requester still cannot approve their own high-risk operation',async()=>{
  const a=await pause();await as('alice',()=>security.changeMember('member','admin','active'));
  await expect(as('member',()=>appApprovals.decide(a.id,'approved','self'))).rejects.toMatchObject({code:'SELF_APPROVAL_FORBIDDEN'});expect(executed).toEqual(['a']);
 });
 it('rechecks revoked permissions between consuming approval and actual execution',async()=>{
  const a=await pause();await as('admin',()=>appApprovals.decide(a.id,'approved',''));
  const start=lifecycle.startTool.bind(lifecycle);vi.spyOn(lifecycle,'startTool').mockImplementation(async(...args)=>{
   const ok=await start(...args);if(args[2].id==='get_high_risk_transactions')await as('alice',()=>security.changeMember('member','member','removed'));return ok;
  });
  expect((await resume()).status).toBe('failed');expect(executed).toEqual(['a']);
 });
 it('rolls back checkpoint, request, and lease release when request audit fails',async()=>{
  await db.admin.query(`CREATE FUNCTION fail_request_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='approval.requested' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$`);
  await db.admin.query('CREATE TRIGGER fault BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_request_audit()');
  const result=await as('member',()=>executor().execute(job,new AbortController().signal));expect(result).toMatchObject({status:'failed',error:{code:'AUDIT_UNAVAILABLE'}});
  expect((await db.admin.query('SELECT * FROM agent_checkpoints')).rowCount).toBe(0);expect((await db.admin.query('SELECT * FROM agent_approvals')).rowCount).toBe(0);
  expect((await db.admin.query('SELECT lease_token FROM agent_jobs WHERE id=$1',[job.id])).rows[0].lease_token).toBe(job.lease_token);expect(executed).toEqual(['a']);
 });
 it('closes SSE while paused and replays only committed approval events on reconnect',async()=>{
  const {runEventStream}=await import('../../../apps/web/src/lib/run-event-stream');const {readSSE}=await import('../../../apps/web/src/lib/sse');
  const a=await pause();let cursor='0';
  await as('alice',async()=>{const stream=runEventStream({runId,cursor,signal:new AbortController().signal,store:new PersistenceStore(db.app),events:new AgentEventStore(db.app)});const received=[];for await(const event of readSSE(stream,id=>{cursor=id;}))received.push(event);expect(received.at(-1)).toMatchObject({type:'approval',status:'waiting_approval'});});
  await as('admin',()=>appApprovals.decide(a.id,'approved',''));await resume();
  await as('alice',async()=>{const stream=runEventStream({runId,cursor,signal:new AbortController().signal,store:new PersistenceStore(db.app),events:new AgentEventStore(db.app)});const received=[];for await(const event of readSSE(stream))received.push(event);expect(received.filter(e=>e.type==='approval').map(e=>e.status)).toEqual(['approved','resumed']);expect(received.at(-1)).toEqual({type:'done'});});
 });
 it('uses the database expiry guard even when application time is behind',async()=>{
  const original=approvals.pause.bind(approvals);vi.spyOn(approvals,'pause').mockImplementation((j,s)=>original(j,s,0.02));const a=await pause();await new Promise(r=>setTimeout(r,35));
  const clock=vi.spyOn(Date,'now').mockReturnValue(0);
  try{await expect(as('admin',()=>appApprovals.decide(a.id,'approved',''))).rejects.toMatchObject({status:410,code:'APPROVAL_EXPIRED'});}finally{clock.mockRestore();}
  await approvals.expire();expect((await db.admin.query('SELECT status FROM agent_approvals WHERE id=$1',[a.id])).rows[0].status).toBe('expired');expect(await queue.claim('none')).toBeNull();expect(executed).toEqual(['a']);
 });
 it('survives a real Worker process shutdown and resumes in a fresh process exactly once',async()=>{
  let downstreamCalls=0;
  const api=createServer((request,response)=>{
   downstreamCalls++;expect(request.headers['x-eap-tenant-id']).toBe(tenant);expect(request.headers['x-eap-actor-id']).toBe('member');
   response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({items:[],total:0}));
  });
  await new Promise<void>(resolve=>api.listen(0,'127.0.0.1',resolve));const address=api.address();if(!address||typeof address==='string')throw new Error('Test HTTP server unavailable');
  let child:ChildProcess|undefined;
  const start=(workerId:string)=>spawn(process.execPath,['--import','tsx','src/index.ts'],{
   cwd:new URL('../',import.meta.url),stdio:'ignore',env:{...process.env,DATABASE_URL:db.connectionString,PGOPTIONS:`-c search_path=${db.schema}`,
    LLM_PROVIDER:'mock',LLM_MODEL:'mock-model',AGENT_CHECKPOINT_KEY:'11'.repeat(32),OTEL_ENABLED:'false',BUSINESS_API_URL:`http://127.0.0.1:${address.port}`,
    BUSINESS_API_KEY:'test-only-service-key-at-least-32-characters',WORKER_ID:workerId,WORKER_POLL_INTERVAL_MS:'20',WORKER_LEASE_SECONDS:'2',WORKER_MAX_DURATION_MS:'60000'},
  });
  async function stop(){if(!child||child.exitCode!==null)return;const exiting=once(child,'exit');child.kill('SIGTERM');let timer:ReturnType<typeof setTimeout>|undefined;
   try{const [code]=await Promise.race([exiting,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{child?.kill('SIGKILL');reject(new Error('Test Worker did not stop'));},5000);})]);expect(code).toBe(0);}finally{if(timer)clearTimeout(timer);child=undefined;}}
  async function until(status:string){const deadline=Date.now()+8000;while(true){const current=(await db.admin.query('SELECT status FROM agent_runs WHERE id=$1',[runId])).rows[0];if(current.status===status)return;
   if(child?.exitCode!==null&&child?.exitCode!==undefined)throw new Error('Test Worker exited before expected state');if(Date.now()>deadline)throw new Error(`Worker did not reach ${status}`);await new Promise(r=>setTimeout(r,20));}}
  try{
   await db.admin.query("UPDATE agent_jobs SET status='queued',attempt=0,lease_token=NULL,lease_expires_at=NULL,worker_id=NULL WHERE id=$1",[job.id]);await db.admin.query("UPDATE agent_runs SET status='pending' WHERE id=$1",[runId]);
   child=start('acceptance-before-restart');await until('waiting_approval');
   const waiting=(await db.admin.query('SELECT lease_token,worker_id FROM agent_jobs WHERE id=$1',[job.id])).rows[0];expect(waiting).toEqual({lease_token:null,worker_id:null});expect(downstreamCalls).toBe(0);
   await stop();const [approval]=await as('admin',()=>appApprovals.list());await as('admin',()=>appApprovals.decide(approval.id,'approved','restart acceptance'));
   child=start('acceptance-after-restart');await until('completed');await stop();expect(downstreamCalls).toBe(1);
   expect((await db.admin.query('SELECT worker_id,attempt FROM agent_jobs WHERE id=$1',[job.id])).rows[0]).toEqual({worker_id:'acceptance-after-restart',attempt:2});
   const run=(await db.admin.query('SELECT model_calls,tool_calls FROM agent_runs WHERE id=$1',[runId])).rows[0];expect(run).toEqual({model_calls:3,tool_calls:1});
   expect((await db.admin.query('SELECT status FROM tool_executions WHERE run_id=$1',[runId])).rows).toEqual([{status:'succeeded'}]);
   expect((await db.admin.query('SELECT total_tokens FROM agent_usage WHERE run_id=$1',[runId])).rows.map(r=>Number(r.total_tokens))).toEqual([80]);
  }finally{try{await stop();}finally{api.closeAllConnections();await new Promise<void>(resolve=>api.close(()=>resolve()));}}
 },20000);
 it('Worker releases lease on pause and processes another queued job in the same slot',async()=>{
  await db.admin.query("UPDATE agent_jobs SET status='queued',attempt=0,lease_token=NULL,lease_expires_at=NULL,worker_id=NULL WHERE id=$1",[job.id]);
  await db.admin.query("UPDATE agent_runs SET status='pending' WHERE id=$1",[runId]);
  const stop=new AbortController();const errors:unknown[]=[];
  const worker=runWorker({queue,lifecycle,executor:executor(),approvals,workerId:'live',signal:stop.signal,pollIntervalMs:10,leaseSeconds:1,onError:e=>errors.push(e)});
  async function until(check:()=>Promise<boolean>){const deadline=Date.now()+3000;while(!await check()){if(Date.now()>deadline)throw new Error('Worker did not progress');await new Promise(r=>setTimeout(r,10));}}
  try{
   await until(async()=> (await db.admin.query('SELECT status FROM agent_jobs WHERE id=$1',[job.id])).rows[0].status==='waiting_approval');
   const second=await as('member',()=>new JobLifecycle(db.app,security).submit({requestKey:randomUUID(),messages:[{role:'user',content:'second'}]}));
   await until(async()=> (await db.admin.query('SELECT status FROM agent_runs WHERE id=$1',[second.id])).rows[0].status==='completed');
   expect((await db.admin.query('SELECT lease_token FROM agent_jobs WHERE id=$1',[job.id])).rows[0].lease_token).toBeNull();expect(errors).toEqual([]);
  }finally{stop.abort();await worker;}
 });
});
