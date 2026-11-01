import { beforeEach,afterEach,it,expect,vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { securityDatabase } from '../../../packages/persistence/tests/security-database';
import { SecurityStore,withSecurityContext,JobLifecycle,AgentJobQueue,PersistenceStore,AgentEventStore } from '@eap/persistence';
import { createBusinessTools,ToolError } from '@eap/tools';
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
 const tools=createBusinessTools({baseURL:'http://business.test',fetchImpl,authorize:async name=>{try{return await workerSecurity.authorizeTool(name);}catch{throw new ToolError('TOOL_FORBIDDEN','Denied');}}});
 const lifecycle=new JobLifecycle(db.worker);const store=new PersistenceStore(db.worker);
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
