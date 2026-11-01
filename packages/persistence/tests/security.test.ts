import { beforeEach,afterEach,describe,it,expect,vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { securityDatabase } from './security-database';
import { SecurityStore,SecurityError,rolePermissions } from '../src/security';
import { withSecurityContext } from '../src/security-context';
import { PersistenceStore } from '../src/store';
import { JobLifecycle } from '../src/job-lifecycle';
import { AgentJobQueue } from '../src/job-queue';
import { AgentEventStore } from '../src/event-store';

describe('real restricted PostgreSQL security boundaries',()=>{
 let db:Awaited<ReturnType<typeof securityDatabase>>,security:SecurityStore,store:PersistenceStore,lifecycle:JobLifecycle;
 let a:string,b:string;
 const as=<T>(tenantId:string,actorUserId:string,fn:()=>T)=>withSecurityContext({tenantId,actorUserId},fn);
 beforeEach(async()=>{
  db=await securityDatabase();security=new SecurityStore(db.app);store=new PersistenceStore(db.app);lifecycle=new JobLifecycle(db.app,security);
  for(const user of ['alice','bob','viewer','member'])await db.auth.query('INSERT INTO "user"(id,name,email) VALUES($1,$1,$2)',[user,`${user}@example.test`]);
  a=(await withSecurityContext({actorUserId:'alice'},()=>security.createTenant('A'))).id;
  b=(await withSecurityContext({actorUserId:'bob'},()=>security.createTenant('B'))).id;
  await as(a,'alice',()=>security.changeMember('viewer','viewer','active'));
  await as(a,'alice',()=>security.changeMember('member','member','active'));
 });
 afterEach(async()=>{await db?.close();});
 const submit=()=>lifecycle.submit({requestKey:randomUUID(),messages:[{role:'user',content:'hello'}]});
 it('uses a real non-owner, non-bypass login; no context means no rows',async()=>{
  const role=(await db.raw.query('SELECT current_user,session_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
  expect(role.current_user).toBe(role.session_user);expect(role.rolsuper).toBe(false);expect(role.rolbypassrls).toBe(false);
  expect(await store.listConversations()).toEqual([]);
  await expect(store.createConversation('forbidden')).rejects.toThrow();
 });
 it('isolates conversation, run, SSE events, cancellation and usage',async()=>{
  const run=await as(b,'bob',submit);
  await as(a,'alice',async()=>{
   expect(await store.getConversation(run.conversation_id)).toBeNull();expect(await store.getRun(run.id)).toBeNull();
   expect(await new AgentEventStore(db.app).listAfter(run.id,'0')).toEqual([]);
   expect(await new AgentJobQueue(db.app).requestCancellation(run.id)).toBe(false);expect(await store.usageByModel()).toEqual([]);
  });
 });
 it('rejects cross-tenant parent links, including a message referencing a different conversation',async()=>{
  const ar=await as(a,'alice',submit);const br=await as(b,'bob',submit);
  await as(a,'alice',async()=>{
   await expect(db.app.query('INSERT INTO agent_runs(id,conversation_id,trace_id,tenant_id) VALUES($1,$2,$3,$4)',[randomUUID(),br.conversation_id,randomUUID(),a])).rejects.toThrow();
   const other=await store.createConversation('other');
   await expect(db.app.query("INSERT INTO messages(id,conversation_id,run_id,role,content) VALUES($1,$2,$3,'user','{}')",[randomUUID(),other.id,ar.id])).rejects.toThrow();
  });
 });
 it('does not leak context across pooled reuse, rollback, or concurrent tenants',async()=>{
  await Promise.all([as(a,'alice',()=>store.createConversation('A')),as(b,'bob',()=>store.createConversation('B'))]);
  await as(a,'alice',async()=>{const c=await db.app.connect();try{await c.query('BEGIN');await c.query("SELECT 1/0");}catch{await c.query('ROLLBACK');}finally{c.release();}});
  for(let i=0;i<8;i++)await Promise.all([as(a,'alice',async()=>expect((await store.listConversations()).map(c=>c.title)).toEqual(['A'])),as(b,'bob',async()=>expect((await store.listConversations()).map(c=>c.title)).toEqual(['B']))]);
  expect((await db.raw.query("SELECT current_setting('eap.tenant_id',true) AS tenant")).rows[0].tenant??'').toBe('');
 });
 it('shares identity with an existing scoped pool across module hot reload',async()=>{
  await as(a,'alice',()=>store.createConversation('A'));
  vi.resetModules();
  const reloaded=await import('../src/security-context');
  const rows=await reloaded.withSecurityContext({tenantId:a,actorUserId:'alice'},()=>store.listConversations());
  expect(rows.map(row=>row.title)).toEqual(['A']);
 });
 it('denies viewer execution and member policy/role escalation',async()=>{
  expect(rolePermissions.viewer).not.toContain('agent:execute');
  await expect(as(a,'viewer',submit)).rejects.toMatchObject({status:403});
  await expect(as(a,'member',()=>security.changeMember('member','owner','active'))).rejects.toMatchObject({status:403});
  await expect(as(a,'member',()=>security.setPolicy({tool_name:'get_high_risk_transactions',enabled:true,allowed_roles:['member'],risk_level:'low',requires_approval:false}))).rejects.toMatchObject({status:403});
 });
 it('serializes owner changes and prevents concurrent last-owner removals',async()=>{
  await as(a,'alice',()=>security.changeMember('member','owner','active'));
  const results=await Promise.allSettled([as(a,'alice',()=>security.changeMember('alice','member','active')),as(a,'member',()=>security.changeMember('member','member','active'))]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect((await db.admin.query("SELECT * FROM tenant_memberships WHERE tenant_id=$1 AND role='owner' AND status='active'",[a])).rowCount).toBe(1);
 });
 it('audits changes transactionally, audits denials, and forbids audit tampering',async()=>{
  await as(a,'alice',()=>security.changeMember('viewer','member','active'));
  await expect(as(a,'member',()=>security.authorize('audit:read'))).rejects.toBeInstanceOf(SecurityError);
  const rows=(await db.admin.query('SELECT * FROM audit_logs WHERE tenant_id=$1',[a])).rows;
  expect(rows.some(r=>r.action==='member.change')).toBe(true);expect(rows.some(r=>r.decision==='deny')).toBe(true);
  expect(JSON.stringify(rows)).not.toContain('password');
  await expect(as(a,'alice',()=>db.app.query('DELETE FROM audit_logs'))).rejects.toThrow();
 });
 it('rolls back authorization changes when the required audit insert fails',async()=>{
  await db.admin.query('REVOKE INSERT ON audit_logs FROM eap_app');
  await expect(as(a,'alice',()=>security.changeMember('viewer','member','active'))).rejects.toThrow();
  expect((await db.admin.query('SELECT role FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2',[a,'viewer'])).rows[0].role).toBe('viewer');
 });
 it('keeps a tenant admission lock across competing submitters',async()=>{
  const results=await as(a,'alice',()=>Promise.allSettled(Array.from({length:8},submit)));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(4);
  for(const r of results)if(r.status==='rejected')expect(r.reason).toMatchObject({status:429,code:'CONCURRENT_RUN_LIMIT'});
 });
 it('shares atomic rate limits across instances and returns Retry-After',async()=>{
  const another=new SecurityStore(db.app);
  const results=await Promise.allSettled(Array.from({length:12},(_,i)=>(i%2?security:another).limit('shared',3,60)));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(3);
  for(const r of results)if(r.status==='rejected')expect(r.reason).toMatchObject({status:429,retryAfter:expect.any(Number)});
 });
 it('persists trusted actor context, scopes idempotency, and uses only narrow cross-tenant queue functions',async()=>{
  const key=randomUUID();const input={requestKey:key,messages:[{role:'user' as const,content:'hello'}]};
  const ar=await as(a,'alice',()=>lifecycle.submit(input));const br=await as(b,'bob',()=>lifecycle.submit(input));expect(ar.id).not.toBe(br.id);
  const q=new AgentJobQueue(db.worker,true);const job=await q.claim('secure-worker',30);expect(job?.actor_user_id).toBeTruthy();
  expect((await db.worker.query('SELECT * FROM agent_jobs')).rows).toEqual([]);
  await expect(db.app.query('SELECT * FROM eap_claim_job($1,$2,$3)',['bad',randomUUID(),30])).rejects.toThrow();
 });
 it('reaps expired secured leases without replay and fences stale finalization',async()=>{
  const run=await as(a,'alice',submit);const q=new AgentJobQueue(db.worker,true);const job=(await q.claim('secure',30))!;
  const workerLife=new JobLifecycle(db.worker);
  expect(await as(a,'alice',()=>workerLife.startTool(job.id,job.lease_token,{id:'intent',name:'get_high_risk_transactions',arguments:'{}'}))).toBe(true);
  await db.admin.query("UPDATE agent_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[job.id]);
  expect(await q.blockExpiredJobs()).toEqual([run.id]);
  expect((await as(a,'alice',()=>store.getRun(run.id)))?.status).toBe('interrupted');
  expect((await db.admin.query('SELECT status FROM tool_executions WHERE run_id=$1',[run.id])).rows[0].status).toBe('unknown');
  const events=await as(a,'alice',()=>new AgentEventStore(db.app).listAfter(run.id,'0'));
  expect(events.filter(e=>e.event_type==='error')).toHaveLength(1);
  expect(await as(a,'alice',()=>workerLife.finalizeJob({jobId:job.id,leaseToken:job.lease_token,status:'completed'}))).toBe(false);
 });
 it('quarantines old data with no automatic ownership',async()=>{
  const legacy=await new PersistenceStore(db.admin).createConversation('old');
  expect((await db.admin.query('SELECT status FROM tenants WHERE id=$1',[legacy.tenant_id])).rows[0].status).toBe('quarantined');
  expect(await as(a,'alice',()=>store.getConversation(legacy.id))).toBeNull();
 });
});
