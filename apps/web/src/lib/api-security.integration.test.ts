import { beforeEach,afterEach,describe,it,expect,vi } from 'vitest';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { securityDatabase } from '../../../../packages/persistence/tests/security-database';
import { ApprovalStore,SecurityStore,PersistenceStore,JobLifecycle,AgentEventStore,AgentJobQueue,withSecurityContext } from '@eap/persistence';
const wiring=vi.hoisted(()=>({auth:vi.fn(),pool:undefined as unknown as Pool,security:undefined as unknown as SecurityStore,store:undefined as unknown as PersistenceStore,lifecycle:undefined as unknown as JobLifecycle}));
vi.mock('./auth',()=>({getAuth:wiring.auth}));
vi.mock('./persistence',()=>({get approvals(){return new ApprovalStore(wiring.pool);},get pool(){return wiring.pool;},get security(){return wiring.security;},get store(){return wiring.store;},get jobLifecycle(){return wiring.lifecycle;},get jobQueue(){return new AgentJobQueue(wiring.pool);},get eventStore(){return new AgentEventStore(wiring.pool);}}));
import { AgentRunner,AgentPaused,MockProvider } from '@eap/ai';
import { createBusinessTools } from '@eap/tools';
import { GET as approvalList } from '../app/api/approvals/route';
import { GET as approvalDetail } from '../app/api/approvals/[id]/route';
import { POST as approve } from '../app/api/approvals/[id]/approve/route';
import { POST as reject } from '../app/api/approvals/[id]/reject/route';
import {GET as evalDatasets,POST as publishEvalDataset} from '../app/api/evaluations/datasets/route';
import {GET as evalDataset} from '../app/api/evaluations/datasets/[id]/route';
import {POST as submitEvalRun,GET as evalRuns} from '../app/api/evaluations/runs/route';
import {GET as evalRun} from '../app/api/evaluations/runs/[id]/route';
import {GET as evalResults} from '../app/api/evaluations/runs/[id]/results/route';
import {GET as compareEvalRun} from '../app/api/evaluations/runs/[id]/compare/route';
import {runEvaluationWorker} from '@eap/evaluation';
import {readFile} from 'node:fs/promises';
import { GET as recentRuns } from '../app/api/agent/runs/route';
import { GET as getRun } from '../app/api/agent/runs/[id]/route';
import { POST as cancel } from '../app/api/agent/runs/[id]/cancel/route';
import { GET as sse } from '../app/api/agent/runs/[id]/events/route';
import { GET as getConversation } from '../app/api/conversations/[id]/route';
import { GET as conversations,POST as createConversation } from '../app/api/conversations/route';
import { POST as submit } from '../app/api/agent/jobs/route';
import { POST as legacyAgent } from '../app/api/agent/stream/route';
import { POST as legacyChat } from '../app/api/chat/route';
import { POST as legacyChatStream } from '../app/api/chat/stream/route';
import { POST as changeMember } from '../app/api/security/members/route';
import { POST as policy } from '../app/api/security/policies/route';
import { GET as audit } from '../app/api/security/audit/route';
import type { createAuth } from './auth';
describe('protected API integration with real sessions and RLS',()=>{
 let db:Awaited<ReturnType<typeof securityDatabase>>,auth:ReturnType<typeof createAuth>,cookie:string,actor:string,a:string,b:string;
 const url='http://localhost:3551';
 const req=(method='GET',tenant=a,body?:unknown,session=cookie)=>new Request(`${url}/api/test`,{method,headers:{Origin:url,Cookie:session,'x-tenant-id':tenant,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:method==='GET'?undefined:JSON.stringify(body??{})});
 const context=(id:string)=>({params:Promise.resolve({id})});
 beforeEach(async()=>{
  vi.stubEnv('AGENT_CHECKPOINT_KEY','22'.repeat(32));vi.stubEnv('BETTER_AUTH_URL',url);db=await securityDatabase();
  wiring.pool=db.app;wiring.security=new SecurityStore(db.app);wiring.store=new PersistenceStore(db.app);wiring.lifecycle=new JobLifecycle(db.app,wiring.security);
  const actual=await vi.importActual<typeof import('./auth')>('./auth');
  auth=actual.createAuth(db.auth,{secret:'test-only-secret-32-characters-for-api',url});wiring.auth.mockResolvedValue(auth);
  const response=await auth.handler(new Request(`${url}/api/auth/sign-up/email`,{method:'POST',headers:{Origin:url,'Content-Type':'application/json'},body:JSON.stringify({name:'Alice',email:'alice@example.test',password:'test-password-with-12-chars'})}));
  expect(response.status).toBe(200);actor=(await response.json()).user.id;cookie=response.headers.getSetCookie().find(c=>c.includes('session_token='))!.split(';')[0];
  a=(await withSecurityContext({actorUserId:actor},()=>wiring.security.createTenant('A'))).id;
  await db.auth.query('INSERT INTO "user"(id,name,email) VALUES(\'bob\',\'Bob\',\'bob@example.test\')');
  b=(await withSecurityContext({actorUserId:'bob'},()=>wiring.security.createTenant('B'))).id;
 });
 afterEach(async()=>{vi.unstubAllEnvs();await db?.close();});
 async function pendingApproval(){
  await withSecurityContext({tenantId:a,actorUserId:actor},()=>wiring.security.setPolicy({tool_name:'get_high_risk_transactions',enabled:true,allowed_roles:['owner','admin','member'],risk_level:'low',requires_approval:true}));
  const run=await withSecurityContext({tenantId:a,actorUserId:actor},()=>wiring.lifecycle.submit({requestKey:randomUUID(),messages:[{role:'user',content:'query'}]}));
  const job=(await new AgentJobQueue(db.worker,true).claim('approval-api'))!;
  await withSecurityContext({tenantId:a,actorUserId:actor},async()=>{
   const runner=new AgentRunner({provider:new MockProvider(),tools:createBusinessTools({baseURL:'http://unused.test'}),beforeTool:async state=>{await new ApprovalStore(db.worker).pause(job,state);throw new AgentPaused();}});
   for await(const event of runner.run({messages:[{role:'user',content:'query'}]}))void event;
  });
  return (await db.admin.query('SELECT id FROM agent_approvals WHERE run_id=$1',[run.id])).rows[0].id as string;
 }
 it('serves redacted approvals and commits one approved decision through authenticated routes',async()=>{
  const id=await pendingApproval();expect((await approvalList(req())).status).toBe(200);
  const detail=await approvalDetail(req(),context(id));expect(detail.status).toBe(200);const payload=await detail.json();expect(payload.approval.display_arguments.limit).toBe(3);expect(payload.approval.tool_arguments).toBeUndefined();
  expect((await approve(req('POST',a,{reason:'checked'}),context(id))).status).toBe(200);
  expect((await reject(req('POST',a,{reason:'late'}),context(id))).status).toBe(409);expect((await approve(req('POST',a,{reason:'duplicate'}),context(id))).status).toBe(409);
 });
 it('rejects a pending approval through HTTP and atomically terminates the original job',async()=>{
  const id=await pendingApproval();const response=await reject(req('POST',a,{reason:'not allowed'}),context(id));expect(response.status).toBe(200);
  const row=(await db.admin.query('SELECT status,run_id,job_id FROM agent_approvals WHERE id=$1',[id])).rows[0];expect(row.status).toBe('rejected');
  expect((await db.admin.query('SELECT status FROM agent_runs WHERE id=$1',[row.run_id])).rows[0].status).toBe('failed');
  expect((await db.admin.query('SELECT status FROM agent_jobs WHERE id=$1',[row.job_id])).rows[0].status).toBe('failed');
  expect((await db.admin.query('SELECT * FROM tool_executions WHERE run_id=$1',[row.run_id])).rowCount).toBe(0);
  expect((await approve(req('POST',a,{reason:'too late'}),context(id))).status).toBe(409);
 });
 it('protects approval routes with session, current role, RLS, origin and strict decision schema',async()=>{
  const id=await pendingApproval();expect((await approvalList(req('GET',a,undefined,''))).status).toBe(401);
  expect((await approve(req('POST',a,{reason:'x',tenant_id:b,approver_user_id:'bob'}),context(id))).status).toBe(400);
  expect((await approve(req('POST',a,{reason:'x'.repeat(501)}),context(id))).status).toBe(400);
  expect((await approvalDetail(req(),context(randomUUID()))).status).toBe(404);
  const evil=new Request(`${url}/api/approvals/${id}/approve`,{method:'POST',headers:{Origin:'https://evil.test',Cookie:cookie,'x-tenant-id':a},body:'{}'});expect((await approve(evil,context(id))).status).toBe(403);
  await db.admin.query("UPDATE tenant_memberships SET role='member' WHERE tenant_id=$1 AND user_id=$2",[a,actor]);
  expect((await approvalList(req())).status).toBe(403);expect((await approve(req('POST',a,{}),context(id))).status).toBe(403);
 });
 it('lists recoverable runs only within the selected tenant, without job lease or checkpoint data',async()=>{
  const own=await withSecurityContext({tenantId:a,actorUserId:actor},()=>wiring.lifecycle.submit({requestKey:randomUUID(),messages:[{role:'user',content:'own chat'}]}));
  const foreign=await withSecurityContext({tenantId:b,actorUserId:'bob'},()=>wiring.lifecycle.submit({requestKey:randomUUID(),messages:[{role:'user',content:'foreign chat'}]}));
  const response=await recentRuns(req());expect(response.status).toBe(200);const body=await response.json();expect(body.runs.map((r:{id:string})=>r.id)).toEqual([own.id]);
  const json=JSON.stringify(body);expect(json).not.toContain(foreign.id);expect(json).not.toContain('lease_token');expect(json).not.toContain('checkpoint');
  expect((await recentRuns(req('GET',a,undefined,''))).status).toBe(401);
 });
 it('protects evaluation import, version access and async run endpoints with session, RBAC and RLS',async()=>{
  const dataset=JSON.parse(await readFile(new URL('../../../../packages/evaluation/datasets/risk-v1.json',import.meta.url),'utf8'));
  expect((await evalDatasets(req('GET',a,undefined,''))).status).toBe(401);
  const published=await publishEvalDataset(req('POST',a,{dataset}));expect(published.status).toBe(201);const version=await published.json();
  expect((await evalDataset(req(),context(version.version_id))).status).toBe(200);
  expect((await publishEvalDataset(req('POST',a,{dataset:{...dataset,executable:'evil()'}}))).status).toBe(400);
  const queued=await submitEvalRun(req('POST',a,{dataset_version_id:version.version_id,config:{provider:'mock',case_timeout_ms:25}}));expect(queued.status).toBe(202);const run=await queued.json();
  expect((await evalRun(req(),context(run.id))).status).toBe(200);expect((await evalResults(req(),context(run.id))).status).toBe(200);
  await db.admin.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')",[b,actor]);
  expect((await evalDataset(req('GET',b),context(version.version_id))).status).toBe(404);expect((await evalRun(req('GET',b),context(run.id))).status).toBe(404);
  expect((await submitEvalRun(req('POST',b,{dataset_version_id:version.version_id}))).status).toBe(404);
  await db.admin.query("UPDATE tenant_memberships SET role='member' WHERE tenant_id=$1 AND user_id=$2",[a,actor]);
  expect((await evalRuns(req())).status).toBe(403);expect((await submitEvalRun(req('POST',a,{dataset_version_id:version.version_id}))).status).toBe(403);
 });
 it('compares persisted compatible evaluations through the authenticated API',async()=>{
  const dataset=JSON.parse(await readFile(new URL('../../../../packages/evaluation/datasets/risk-v1.json',import.meta.url),'utf8'));
  const published=await publishEvalDataset(req('POST',a,{dataset}));const version=await published.json();const controller=new AbortController();const worker=runEvaluationWorker({db:db.worker,workerId:'api-eval',signal:controller.signal,pollMs:10});
  const wait=async(id:string)=>{const deadline=Date.now()+5000;while(true){const row=(await db.admin.query('SELECT status FROM eval_runs WHERE id=$1',[id])).rows[0];if(row.status==='completed')return;if(row.status==='failed')throw new Error('Evaluation failed');if(Date.now()>deadline)throw new Error('Evaluation not complete');await new Promise(r=>setTimeout(r,20));}};
  try{
   const first=await submitEvalRun(req('POST',a,{dataset_version_id:version.version_id,config:{case_timeout_ms:25}}));const baseline=await first.json();await wait(baseline.id);
   const second=await submitEvalRun(req('POST',a,{dataset_version_id:version.version_id,baseline_run_id:baseline.id,config:{case_timeout_ms:25}}));expect(second.status).toBe(202);const current=await second.json();await wait(current.id);
   const response=await compareEvalRun(req(),context(current.id));expect(response.status).toBe(200);const result=await response.json();expect(result.comparison.compatible).toBe(true);expect(result.comparison.regression_cases).toEqual([]);expect(result.comparison.uncertainty).toContain('small_sample');
  }finally{controller.abort();await worker;}
 });
 it('rate limits evaluation submission independently and rejects forged run configuration',async()=>{
  for(let i=0;i<10;i++)await wiring.security.limit(`eval-submit:${a}`,10,60);
  expect((await submitEvalRun(req('POST',a,{dataset_version_id:randomUUID()}))).status).toBe(429);
  expect((await publishEvalDataset(req('POST',a,{dataset:{},tenant_id:b,actor_user_id:'bob'}))).status).toBe(400);
 });
 it('denies anonymous API access including both legacy stream paths',async()=>{
  for(const handler of [createConversation,submit,legacyAgent,legacyChat,legacyChatStream,changeMember,policy])expect((await handler(req('POST',a,{},''))).status).toBe(401);
  expect((await conversations(req('GET',a,undefined,''))).status).toBe(401);
  expect((await getRun(req('GET',a,undefined,''),context(randomUUID()))).status).toBe(401);
 });
 it('returns the same 404 for foreign and nonexistent conversation/run/SSE/cancel resources',async()=>{
  const foreign=await withSecurityContext({tenantId:b,actorUserId:'bob'},()=>wiring.lifecycle.submit({requestKey:randomUUID(),messages:[{role:'user',content:'private'}]}));
  for(const id of [foreign.id,randomUUID()]){
   expect((await getRun(req(),context(id))).status).toBe(404);
   expect((await sse(req(),context(id))).status).toBe(404);
   expect((await cancel(req('POST'),context(id))).status).toBe(404);
  }
  for(const id of [foreign.conversation_id,randomUUID()])expect((await getConversation(req(),context(id))).status).toBe(404);
  expect((await conversations(req('GET',b))).status).toBe(403);
 });
 it('rejects revoked/forged sessions and cross-origin writes',async()=>{
  expect((await conversations(req('GET',a,undefined,'better-auth.session_token=forged'))).status).toBe(401);
  const evil=new Request(`${url}/api/conversations`,{method:'POST',headers:{Origin:'https://evil.example',Cookie:cookie,'x-tenant-id':a},body:'{}'});
  expect((await createConversation(evil)).status).toBe(403);
  await db.auth.query('DELETE FROM "session"');expect((await conversations(req())).status).toBe(401);
 });
 it('rejects forged actors/roles, viewer execution and member administration',async()=>{
  expect((await submit(req('POST',a,{actor_user_id:'bob',role:'owner',messages:[{role:'user',content:'hello'}]}))).status).toBe(400);
  await db.admin.query("UPDATE tenant_memberships SET role='viewer' WHERE tenant_id=$1",[a]);expect((await submit(req('POST',a,{messages:[{role:'user',content:'hello'}]}))).status).toBe(403);
  await db.admin.query("UPDATE tenant_memberships SET role='member' WHERE tenant_id=$1",[a]);
  expect((await changeMember(req('POST',a,{userId:actor,role:'owner',status:'active'}))).status).toBe(403);
  expect((await policy(req('POST',a,{}))).status).toBe(403);
 });
 it('rechecks membership while an SSE stream is connected',async()=>{
  const run=await withSecurityContext({tenantId:a,actorUserId:actor},()=>wiring.lifecycle.submit({requestKey:randomUUID(),messages:[{role:'user',content:'hello'}]}));
  const response=await sse(req(),context(run.id));expect(response.status).toBe(200);const reader=response.body!.getReader();
  await reader.read();await db.admin.query("UPDATE tenant_memberships SET status='removed' WHERE tenant_id=$1",[a]);
  await expect(reader.read()).rejects.toThrow();
 });
 it('enforces the Agent submission quota through HTTP without creating a run',async()=>{
  for(let i=0;i<20;i++)await wiring.security.limit(`job:${a}:${actor}`,20,60);
  const response=await submit(req('POST',a,{messages:[{role:'user',content:'hello'}]}));
  expect(response.status).toBe(429);expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
  expect(await response.json()).toEqual({error:'RATE_LIMITED'});
  expect((await db.admin.query('SELECT 1 FROM agent_runs')).rowCount).toBe(0);
 });
 it('admits exactly four concurrent HTTP submissions for one tenant',async()=>{
  const responses=await Promise.all(Array.from({length:6},()=>submit(req('POST',a,{messages:[{role:'user',content:'hello'}]}))));
  expect(responses.filter(r=>r.status===202)).toHaveLength(4);
  const rejected=responses.filter(r=>r.status===429);expect(rejected).toHaveLength(2);
  for(const response of rejected){expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);expect(await response.json()).toEqual({error:'CONCURRENT_RUN_LIMIT'});}
  expect((await db.admin.query("SELECT 1 FROM agent_runs WHERE tenant_id=$1 AND status IN ('pending','running')",[a])).rowCount).toBe(4);
 });
 it('exposes management audit events without session secrets or submitted messages',async()=>{
  expect((await changeMember(req('POST',a,{userId:'bob',role:'member',status:'active'}))).status).toBe(200);
  expect((await policy(req('POST',a,{tool_name:'get_high_risk_transactions',enabled:false,allowed_roles:['owner'],risk_level:'low',requires_approval:false}))).status).toBe(200);
  const sensitive='SENSITIVE_MESSAGE_MUST_NOT_APPEAR_IN_AUDIT';
  expect((await submit(req('POST',a,{messages:[{role:'user',content:sensitive}]}))).status).toBe(202);
  const response=await audit(req());expect(response.status).toBe(200);const body=await response.json();
  expect(body.events.map((e:{action:string})=>e.action)).toEqual(expect.arrayContaining(['tenant.create','member.change','tool.policy.change']));
  const serialized=JSON.stringify(body);const session=(await db.auth.query('SELECT token FROM "session"')).rows[0];
  for(const secret of [sensitive,session.token,cookie,'test-password-with-12-chars','test-only-secret-32-characters-for-api'])expect(serialized).not.toContain(secret);
 });
 it('returns HTTP 429 and Retry-After for the shared tenant quota',async()=>{
  for(let i=0;i<120;i++)await wiring.security.limit(`tenant:${a}`,120,60);
  const response=await conversations(req());expect(response.status).toBe(429);expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
 });
});
