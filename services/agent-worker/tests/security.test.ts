import { beforeEach,afterEach,it,expect,vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { securityDatabase } from '../../../packages/persistence/tests/security-database';
import { SecurityStore,withSecurityContext,JobLifecycle,AgentJobQueue,PersistenceStore,AgentEventStore } from '@eap/persistence';
import { createBusinessTools } from '@eap/tools';
import { MockProvider } from '@eap/ai';
import { AgentExecutor } from '../src/executor';
let db:Awaited<ReturnType<typeof securityDatabase>>,security:SecurityStore,workerSecurity:SecurityStore,tenantId:string;
const as=<T>(fn:()=>T)=>withSecurityContext({tenantId,actorUserId:'actor'},fn);
beforeEach(async()=>{
 db=await securityDatabase();security=new SecurityStore(db.app);workerSecurity=new SecurityStore(db.worker);
 await db.auth.query('INSERT INTO "user"(id,name,email) VALUES(\'actor\',\'Actor\',\'actor@example.test\')');
 tenantId=(await withSecurityContext({actorUserId:'actor'},()=>security.createTenant('Worker tenant'))).id;
});
afterEach(async()=>{await db?.close();});
async function setup(){
 const fetchImpl=vi.fn(async()=>Response.json({items:[],total:0}));
 const tools=createBusinessTools({baseURL:'http://business.test',fetchImpl,authorize:name=>workerSecurity.authorizeTool(name)});
 const lifecycle=new JobLifecycle(db.worker,workerSecurity);const store=new PersistenceStore(db.worker);
 const exec=new AgentExecutor({store,lifecycle,security:workerSecurity,events:new AgentEventStore(db.worker),provider:new MockProvider(),tools});
 const run=await as(()=>new JobLifecycle(db.app,security).submit({requestKey:randomUUID(),messages:[{role:'user',content:'risk'}]}));
 const job=(await new AgentJobQueue(db.worker,true).claim('test-worker',30))!;
 return {fetchImpl,tools,lifecycle,store,exec,run,job};
}
it('executes a secured job preserving lease, ledger and trusted downstream tenant',async()=>{
 const s=await setup();const result=await as(()=>s.exec.execute(s.job,new AbortController().signal));expect(result.status).toBe('completed');
 expect(s.fetchImpl).toHaveBeenCalledOnce();const options=s.fetchImpl.mock.calls[0] as unknown as [URL,RequestInit];
 expect(new Headers(options[1].headers).get('X-Eap-Tenant-Id')).toBe(tenantId);
 expect(await as(()=>s.lifecycle.finalizeJob({...result,jobId:s.job.id,leaseToken:s.job.lease_token}))).toBe(true);
 expect((await db.admin.query('SELECT status FROM tool_executions')).rows[0].status).toBe('succeeded');
 expect(await as(()=>s.lifecycle.startTool(s.job.id,s.job.lease_token,{id:'replay',name:'get_high_risk_transactions',arguments:'{}'}))).toBe(false);
});
it.each(['disabled tenant','removed member','revoked tool','approval required'])('revalidates %s before the actual downstream call',async reason=>{
 const s=await setup();
 if(reason==='disabled tenant')await db.admin.query("UPDATE tenants SET status='disabled' WHERE id=$1",[tenantId]);
 if(reason==='removed member')await db.admin.query("UPDATE tenant_memberships SET status='removed' WHERE tenant_id=$1",[tenantId]);
 if(reason==='revoked tool')await as(()=>security.setPolicy({tool_name:'get_high_risk_transactions',enabled:false,allowed_roles:['owner'],risk_level:'low',requires_approval:false}));
 if(reason==='approval required')await as(()=>security.setPolicy({tool_name:'get_high_risk_transactions',enabled:true,allowed_roles:['owner'],risk_level:'high',requires_approval:true}));
 await expect(as(()=>s.tools.execute('get_high_risk_transactions',JSON.stringify({date:'2026-11-01',limit:3})))).rejects.toMatchObject({code:'TOOL_FORBIDDEN'});
 expect(s.fetchImpl).not.toHaveBeenCalled();
 expect((await db.admin.query("SELECT * FROM audit_logs WHERE action='tool.execute' AND decision='deny'")).rowCount).toBe(1);
});
it('cannot switch tenant via model arguments, alias, case, or forged job snapshot',async()=>{
 const s=await setup();
 await expect(as(()=>s.tools.execute('get_high_risk_transactions',JSON.stringify({date:'2026-11-01',limit:3,tenant_id:randomUUID()})))).rejects.toMatchObject({code:'INVALID_ARGUMENTS'});
 await expect(as(()=>s.tools.execute('GET_HIGH_RISK_TRANSACTIONS','{}'))).rejects.toMatchObject({code:'TOOL_FORBIDDEN'});
 await expect(as(()=>s.exec.execute({...s.job,tenant_id:randomUUID()},new AbortController().signal))).rejects.toMatchObject({code:'INVALID_JOB_AUTHORIZATION'});
 expect(s.fetchImpl).not.toHaveBeenCalled();
});
it('blocks later tools after an earlier authorized call and permission revocation',async()=>{
 const s=await setup();const args=JSON.stringify({date:'2026-11-01',limit:3});
 await as(()=>s.tools.execute('get_high_risk_transactions',args));
 await db.admin.query("UPDATE tenant_memberships SET status='removed' WHERE tenant_id=$1",[tenantId]);
 await expect(as(()=>s.tools.execute('get_high_risk_transactions',args))).rejects.toMatchObject({code:'TOOL_FORBIDDEN'});expect(s.fetchImpl).toHaveBeenCalledOnce();
});

it.each(['low','high'] as const)('fails closed before %s risk execution when required audit is unavailable',async risk=>{
 const s=await setup();
 await db.admin.query('UPDATE tenant_tool_policies SET risk_level=$2 WHERE tenant_id=$1',[tenantId,risk]);
 await db.admin.query('REVOKE INSERT ON audit_logs FROM eap_worker');
 const output=vi.spyOn(console,'log').mockImplementation(()=>{});
 try {
  const result=await as(()=>s.exec.execute(s.job,new AbortController().signal));
  expect(result.error?.code).toBe('AUDIT_UNAVAILABLE');expect(result.status).toBe('failed');
  expect(s.fetchImpl).not.toHaveBeenCalled();
  const intent=(await db.admin.query('SELECT status,output FROM tool_executions WHERE run_id=$1',[s.run.id])).rows[0];
  expect(intent.status).toBe('failed');expect(intent.output).toContain('AUDIT_UNAVAILABLE');
  expect(await as(()=>s.lifecycle.finalizeJob({...result,jobId:s.job.id,leaseToken:s.job.lease_token}))).toBe(true);
  expect((await db.admin.query('SELECT status,error FROM agent_runs WHERE id=$1',[s.run.id])).rows[0]).toMatchObject({status:'failed',error:{code:'AUDIT_UNAVAILABLE'}});
  const logs=JSON.stringify(output.mock.calls);expect(logs).toContain('security.audit_unavailable');expect(logs).toContain('AUDIT_UNAVAILABLE');
 }finally{output.mockRestore();}
});
it('does not turn a database authorization failure into a model error or execute the tool',async()=>{
 const s=await setup();await db.admin.query('REVOKE EXECUTE ON FUNCTION eap_role(uuid,text) FROM eap_worker');
 try {
  await expect(as(()=>s.tools.execute('get_high_risk_transactions',JSON.stringify({date:'2026-11-01',limit:3})))).rejects.toMatchObject({code:'AUTHORIZATION_UNAVAILABLE',executionStarted:false});
  expect(s.fetchImpl).not.toHaveBeenCalled();
 }finally{await db.admin.query('GRANT EXECUTE ON FUNCTION eap_role(uuid,text) TO eap_worker');}
});
it('audits high-risk authorization before a committed external effect, records outcome separately, and fences replay',async()=>{
 const s=await setup();await db.admin.query("UPDATE tenant_tool_policies SET risk_level='high' WHERE tenant_id=$1",[tenantId]);
 await db.admin.query('CREATE TABLE simulated_external_effects(id int PRIMARY KEY)');
 s.fetchImpl.mockImplementation(async()=>{
  expect((await db.admin.query("SELECT 1 FROM audit_logs WHERE tenant_id=$1 AND action='tool.execute' AND decision='allow'",[tenantId])).rowCount).toBe(1);
  await db.admin.query('INSERT INTO simulated_external_effects VALUES(1)');return Response.json({items:[],total:0});
 });
 const result=await as(()=>s.exec.execute(s.job,new AbortController().signal));expect(result.status).toBe('completed');
 const replay=await as(()=>s.exec.execute(s.job,new AbortController().signal));expect(replay.error?.code).toBe('TOOL_REPLAY_BLOCKED');
 expect((await db.admin.query('SELECT * FROM simulated_external_effects')).rowCount).toBe(1);
 expect((await db.admin.query('SELECT * FROM tool_executions WHERE run_id=$1',[s.run.id])).rowCount).toBe(1);
 const audits=(await db.admin.query("SELECT action,reason_code FROM audit_logs WHERE tenant_id=$1 AND action IN ('tool.execute','tool.execution.result') ORDER BY timestamp",[tenantId])).rows;
 expect(audits).toEqual([{action:'tool.execute',reason_code:'POLICY_ALLOWED'},{action:'tool.execution.result',reason_code:'SUCCEEDED'}]);
});
it('keeps UNKNOWN and blocks replay after external success but outcome audit/writeback fails',async()=>{
 const s=await setup();await db.admin.query("UPDATE tenant_tool_policies SET risk_level='high' WHERE tenant_id=$1",[tenantId]);
 await db.admin.query('CREATE TABLE simulated_external_effects(id int PRIMARY KEY)');
 s.fetchImpl.mockImplementation(async()=>{
  await db.admin.query('INSERT INTO simulated_external_effects VALUES(1)');
  await db.admin.query('REVOKE INSERT ON audit_logs FROM eap_worker');
  return Response.json({items:[],total:0});
 });
 const result=await as(()=>s.exec.execute(s.job,new AbortController().signal));expect(result.error?.code).toBe('EXECUTION_OUTCOME_UNKNOWN');
 expect((await db.admin.query('SELECT status FROM tool_executions WHERE run_id=$1',[s.run.id])).rows[0].status).toBe('running');
 expect(await as(()=>s.lifecycle.finalizeJob({...result,jobId:s.job.id,leaseToken:s.job.lease_token}))).toBe(true);
 expect((await db.admin.query('SELECT status FROM tool_executions WHERE run_id=$1',[s.run.id])).rows[0].status).toBe('unknown');
 expect((await db.admin.query('SELECT status FROM agent_jobs WHERE id=$1',[s.job.id])).rows[0].status).toBe('blocked');
 await as(()=>s.exec.execute(s.job,new AbortController().signal));
 expect((await db.admin.query('SELECT * FROM simulated_external_effects')).rowCount).toBe(1);
});
it('records only authorization metadata, without sensitive arguments, tokens or tool output',async()=>{
 const s=await setup();const secret='sensitive-tool-output-and-key-marker';
 s.fetchImpl.mockResolvedValue(Response.json({items:[{id:secret,amount:1,currency:'USD',risk_score:90,risk_level:'HIGH',risk_reason:secret,created_at:'2026-11-01'}],total:1}));
 const result=await as(()=>s.exec.execute(s.job,new AbortController().signal));expect(result.status).toBe('completed');
 const audit=JSON.stringify((await db.admin.query('SELECT * FROM audit_logs WHERE tenant_id=$1',[tenantId])).rows);
 for(const value of [secret,'rawArguments','risk_reason','Bearer','password'])expect(audit).not.toContain(value);
});
