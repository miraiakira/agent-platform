import {it,expect} from 'vitest';
import {createTestDatabase} from '../../../packages/persistence/tests/database';
import {AgentJobQueue,JobLifecycle,PersistenceStore} from '@eap/persistence';
import {runWorker} from '../src/worker';
it('SIGTERM stops new claims but drains a running job while renewing its lease',async()=>{
 const db=await createTestDatabase(),queue=new AgentJobQueue(db.pool),lifecycle=new JobLifecycle(db.pool),store=new PersistenceStore(db.pool),stop=new AbortController();let entered!:()=>void,release!:()=>void;
 const started=new Promise<void>(r=>entered=r),finish=new Promise<void>(r=>release=r);let count=0;
 try{const first=await lifecycle.submit({requestKey:crypto.randomUUID(),messages:[{role:'user',content:'one'}]});const second=await lifecycle.submit({requestKey:crypto.randomUUID(),messages:[{role:'user',content:'two'}]});
  const worker=runWorker({queue,lifecycle,executor:{async execute(){count++;entered();await finish;return {status:'completed'};}},workerId:'drain',signal:stop.signal,shutdownGraceMs:1000,leaseSeconds:0.2,pollIntervalMs:10});
  await started;stop.abort();await new Promise(r=>setTimeout(r,250));release();await worker;expect(count).toBe(1);expect((await store.getRun(first.id))?.status).toBe('completed');expect((await store.getRun(second.id))?.status).toBe('pending');
 }finally{stop.abort();release?.();await db.close();}
});
it('drain deadline fences a noncooperative executor and leaves a durable terminal event',async()=>{
 const db=await createTestDatabase(),queue=new AgentJobQueue(db.pool),lifecycle=new JobLifecycle(db.pool),stop=new AbortController();let entered!:()=>void;const started=new Promise<void>(r=>entered=r);
 try{const run=await lifecycle.submit({requestKey:crypto.randomUUID(),messages:[{role:'user',content:'one'}]});
  const worker=runWorker({queue,lifecycle,executor:{execute:async()=>{entered();return new Promise(()=>{});}},workerId:'bounded-drain',signal:stop.signal,shutdownGraceMs:30,leaseSeconds:0.2,pollIntervalMs:10});await started;stop.abort();await worker;
  expect((await new PersistenceStore(db.pool).getRun(run.id))?.error).toMatchObject({code:'WORKER_STOPPED'});expect((await db.pool.query("SELECT count(*)::int AS n FROM agent_events WHERE run_id=$1 AND event_type='error'",[run.id])).rows[0].n).toBe(1);
 }finally{stop.abort();await db.close();}
});
