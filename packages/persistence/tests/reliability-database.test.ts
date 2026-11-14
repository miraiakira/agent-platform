import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {securityDatabase} from './security-database';
import {SecurityStore} from '../src/security';
import {withSecurityContext} from '../src/security-context';
import {JobLifecycle} from '../src/job-lifecycle';
import {AgentJobQueue} from '../src/job-queue';
let db:Awaited<ReturnType<typeof securityDatabase>>,a:string,b:string,security:SecurityStore,lifecycle:JobLifecycle;
const as=<T>(tenant:string,actor:string,fn:()=>T)=>withSecurityContext({tenantId:tenant,actorUserId:actor},fn);
beforeEach(async()=>{db=await securityDatabase();security=new SecurityStore(db.app);lifecycle=new JobLifecycle(db.app,security);for(const user of ['a','b'])await db.auth.query('INSERT INTO "user"(id,name,email) VALUES($1,$1,$2)',[user,`${user}@reliability.test`]);a=(await withSecurityContext({actorUserId:'a'},()=>security.createTenant('A'))).id;b=(await withSecurityContext({actorUserId:'b'},()=>security.createTenant('B'))).id;});
afterEach(async()=>{await db?.close();vi.unstubAllEnvs();});
const submit=(t=a,u='a',key=randomUUID())=>as(t,u,()=>lifecycle.submit({requestKey:key,messages:[{role:'user',content:'test'}]}));
it('rejects queue saturation atomically, admits no phantom jobs, and keeps idempotent retries',async()=>{
 vi.stubEnv('AGENT_TENANT_ADMISSION_LIMIT','8');vi.stubEnv('AGENT_TENANT_QUEUE_LIMIT','2');const key=randomUUID();const run=await submit(a,'a',key);await submit();
 await expect(submit()).rejects.toMatchObject({status:429,code:'TENANT_QUEUE_LIMIT',retryAfter:5});expect((await submit(a,'a',key)).id).toBe(run.id);
 expect((await db.admin.query('SELECT count(*)::int AS n FROM agent_runs')).rows[0].n).toBe(2);expect((await db.admin.query('SELECT count(*)::int AS n FROM agent_jobs')).rows[0].n).toBe(2);
});
it('serializes fleet admission across tenants without losing accepted jobs',async()=>{
 vi.stubEnv('AGENT_GLOBAL_ADMISSION_LIMIT','3');const results=await Promise.allSettled(Array.from({length:8},(_,i)=>submit(i%2?a:b,i%2?'a':'b')));
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(3);for(const r of results)if(r.status==='rejected')expect(r.reason).toMatchObject({status:503,code:'GLOBAL_CAPACITY_LIMIT'});
 expect((await db.admin.query('SELECT count(*)::int AS n FROM agent_jobs')).rows[0].n).toBe(3);
});
it('fairly dispatches an eligible second tenant despite a hot tenant backlog',async()=>{
 vi.stubEnv('AGENT_TENANT_ADMISSION_LIMIT','16');for(let n=0;n<6;n++)await submit();await submit(b,'b');
 const queue=new AgentJobQueue(db.worker,true),one=(await queue.claim('one'))!,two=(await queue.claim('two'))!;
 expect(new Set([one.tenant_id,two.tenant_id])).toEqual(new Set([a,b]));
 const hot=one.tenant_id===a?one:two;await as(a,'a',()=>new JobLifecycle(db.worker).finalizeJob({jobId:hot.id,leaseToken:hot.lease_token,status:'completed'}));
 const next=(await queue.claim('next'))!;expect(next.tenant_id).toBe(a);
 const active=(await db.admin.query("SELECT count(*)::int AS n FROM agent_jobs WHERE tenant_id=$1 AND status='running'",[a])).rows[0].n;expect(active).toBeLessThanOrEqual(2);
});
it('publishes aggregate queue health only to the worker service role',async()=>{
 await submit();const snapshot=(await db.worker.query('SELECT * FROM eap_worker_snapshot($1,$2)',['test-worker',2])).rows[0];expect(Number(snapshot.queued)).toBe(1);expect(Number(snapshot.live_workers)).toBe(1);
 await expect(as(a,'a',()=>db.app.query('SELECT * FROM eap_worker_snapshot($1,$2)',['forged',2]))).rejects.toThrow();
});
it('bounded pool exhaustion and PostgreSQL statement timeout release capacity',async()=>{
 const {Pool}=await import('pg');const url=new URL(process.env.TEST_DATABASE_URL!);const pool=new Pool({connectionString:url.toString(),max:1,connectionTimeoutMillis:50,statement_timeout:50});pool.on('error',()=>{});
 try{const held=await pool.connect();await expect(pool.query('SELECT 1')).rejects.toThrow();held.release();await expect(pool.query('SELECT pg_sleep(0.2)')).rejects.toThrow('statement timeout');expect((await pool.query('SELECT 1 AS n')).rows[0].n).toBe(1);}finally{await pool.end();}
});
