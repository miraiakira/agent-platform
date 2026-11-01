import { beforeEach,afterEach,describe,it,expect,vi } from 'vitest';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { securityDatabase } from '../../../../packages/persistence/tests/security-database';
import { SecurityStore,PersistenceStore,JobLifecycle,AgentEventStore,AgentJobQueue,withSecurityContext } from '@eap/persistence';
const wiring=vi.hoisted(()=>({auth:vi.fn(),pool:undefined as unknown as Pool,security:undefined as unknown as SecurityStore,store:undefined as unknown as PersistenceStore,lifecycle:undefined as unknown as JobLifecycle}));
vi.mock('./auth',()=>({getAuth:wiring.auth}));
vi.mock('./persistence',()=>({get pool(){return wiring.pool;},get security(){return wiring.security;},get store(){return wiring.store;},get jobLifecycle(){return wiring.lifecycle;},get jobQueue(){return new AgentJobQueue(wiring.pool);},get eventStore(){return new AgentEventStore(wiring.pool);}}));
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
  vi.stubEnv('BETTER_AUTH_URL',url);db=await securityDatabase();
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
