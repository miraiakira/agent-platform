import {it,expect,vi} from 'vitest';
import {spawn,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {securityDatabase} from '../../../packages/persistence/tests/security-database';
import {SecurityStore,withSecurityContext,JobLifecycle} from '@eap/persistence';
it.each(['before','after'])('SIGKILL %s an external effect blocks uncertain replay and fences the crashed owner',async phase=>{
 const db=await securityDatabase();let child:ChildProcess|undefined,entered!:()=>void,effects=0;const requested=new Promise<void>(r=>entered=r),children:ChildProcess[]=[];
 const api=createServer((request,response)=>{request.resume();expect(request.headers.authorization).toBe('Bearer isolated-crash-service-secret-32-characters');if(phase==='after')effects++;entered();void response;});
 await new Promise<void>(r=>api.listen(0,'127.0.0.1',r));const addr=api.address();if(!addr||typeof addr==='string')throw new Error('FIXTURE_FAILED');
 try{
  await db.auth.query('INSERT INTO "user"(id,name,email) VALUES(\'crash\',\'Crash\',\'crash@test.invalid\')');const security=new SecurityStore(db.app),tenant=(await withSecurityContext({actorUserId:'crash'},()=>security.createTenant('Crash'))).id;
  const as=<T>(fn:()=>T)=>withSecurityContext({tenantId:tenant,actorUserId:'crash'},fn);
  const run=await as(()=>new JobLifecycle(db.app,security).submit({requestKey:randomUUID(),messages:[{role:'user',content:'high risk transactions'}]}));
  const start=(workerId:string)=>{const c=spawn(process.execPath,['--import','tsx','src/index.ts'],{cwd:new URL('../',import.meta.url),stdio:'ignore',env:{...process.env,DATABASE_URL:db.connectionString,PGOPTIONS:`-c search_path=${db.schema}`,LLM_PROVIDER:'mock',LLM_MODEL:'mock-model',EMBEDDING_PROVIDER:'mock',OTEL_ENABLED:'false',BUSINESS_API_KEY:'isolated-crash-service-secret-32-characters',BUSINESS_API_URL:`http://127.0.0.1:${addr.port}`,WORKER_ID:workerId,WORKER_CONCURRENCY:'1',WORKER_LEASE_SECONDS:'0.2',WORKER_POLL_INTERVAL_MS:'10',WORKER_SHUTDOWN_GRACE_MS:'100'}});children.push(c);return c;};
  child=start('crash-before');let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([requested,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('WORKER_DID_NOT_REACH_EFFECT_WINDOW')),8000);})]);}finally{if(timer)clearTimeout(timer);}
  const old=(await db.admin.query('SELECT id,lease_token FROM agent_jobs WHERE run_id=$1',[run.id])).rows[0];const died=once(child,'exit');child.kill('SIGKILL');await died;await new Promise(r=>setTimeout(r,250));child=start('recovery-after');
  const until=Date.now()+8000;while((await db.admin.query('SELECT status FROM agent_runs WHERE id=$1',[run.id])).rows[0].status!=='interrupted'){if(Date.now()>until)throw new Error('RECOVERY_TIMEOUT');await new Promise(r=>setTimeout(r,20));}
  expect(effects).toBe(phase==='after'?1:0);expect((await db.admin.query('SELECT status FROM tool_executions WHERE run_id=$1',[run.id])).rows).toEqual([{status:'unknown'}]);
  expect(await as(()=>new JobLifecycle(db.worker).finalizeJob({jobId:old.id,leaseToken:old.lease_token,status:'completed'}))).toBe(false);
  expect((await db.admin.query("SELECT payload->>'code' AS code FROM agent_events WHERE run_id=$1 AND event_type='error'",[run.id])).rows).toEqual([{code:'LEASE_EXPIRED'}]);
 }finally{for(const c of children)if(c.exitCode===null&&c.signalCode===null)c.kill('SIGTERM');await Promise.all(children.map(c=>new Promise<void>(r=>{if(c.exitCode!==null||c.signalCode!==null)r();else{const timer=setTimeout(()=>{c.kill('SIGKILL');r();},4000);c.once('exit',()=>{clearTimeout(timer);r();});}})));api.closeAllConnections();await new Promise<void>(r=>api.close(()=>r()));await db.close();vi.unstubAllEnvs();}
},20000);
