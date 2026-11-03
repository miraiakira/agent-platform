import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { currentTraceId, log } from '@eap/observability';
import { securityContext, withSecurityContext, type SecurityContext } from './security-context';
import { transaction } from './transaction';
import { argumentsHash } from './approval-crypto';
import type { ApprovalGrant } from './approvals';
export const roles = ['owner','admin','member','viewer'] as const;
export type Role = typeof roles[number];
export const permissions = ['conversation:create','conversation:read','conversation:delete','agent:execute','agent:cancel','agent:read','tool:execute','tool:manage','tenant:manage','member:invite','member:manage','audit:read','approval:read','approval:decide','evaluation:read','evaluation:manage','evaluation:run'] as const;
export type Permission = typeof permissions[number];
const read: Permission[]=['conversation:read','agent:read'];
const member: Permission[]=[...read,'conversation:create','agent:execute','agent:cancel','tool:execute'];
export const rolePermissions: Record<Role, readonly Permission[]>={owner:permissions,admin:permissions,member,viewer:read};
export class SecurityError extends Error {
 constructor(public readonly status:number,public readonly code:string,public readonly retryAfter?:number) {super(code);}
}
export interface ToolPolicy {tool_name:string;enabled:boolean;allowed_roles:Role[];risk_level:'low'|'high';requires_approval:boolean;policy_version:number;}
export class SecurityStore {
 constructor(readonly db:Pool) {}
 async audit(action:string,resourceType:string,resourceId:string|null,decision:'allow'|'deny',reason:string,client:Pool|PoolClient=this.db) {
  const ctx=securityContext();
  await client.query(`INSERT INTO audit_logs(event_id,tenant_id,actor_user_id,action,resource_type,resource_id,decision,reason_code,trace_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[randomUUID(),ctx?.tenantId??null,ctx?.actorUserId??null,action,resourceType,resourceId,decision,reason,currentTraceId()??null]);
 }
 async role(client:Pool|PoolClient=this.db):Promise<Role|null> {
  const ctx=securityContext(); if(!ctx?.tenantId) return null;
  const {rows}=await client.query('SELECT eap_role($1,$2) AS role',[ctx.tenantId,ctx.actorUserId]);
  return roles.includes(rows[0]?.role) ? rows[0].role : null;
 }
 async authorize(permission:Permission,client:Pool|PoolClient=this.db) {
  const role=await this.role(client);
  if(!role || !rolePermissions[role].includes(permission)) {
   // Denials are committed independently of a business transaction that will roll back.
   // A transaction denial is audited by the API boundary after rollback; never borrow
   // another pooled connection while holding one (pool exhaustion can deadlock).
   if(client===this.db) await this.audit(permission,'tenant',securityContext()?.tenantId??null,'deny','FORBIDDEN');
   throw new SecurityError(403,'FORBIDDEN');
  }
  return role;
 }
 async listTenants() { return (await this.db.query(`SELECT t.id,t.name,t.status,m.role FROM tenants t JOIN tenant_memberships m ON m.tenant_id=t.id
  WHERE m.user_id=$1 AND m.status='active' AND t.status='active' ORDER BY t.created_at`,[securityContext()?.actorUserId])).rows; }
 async createTenant(name:string) {
  const actor=securityContext()?.actorUserId; if(!actor) throw new SecurityError(401,'UNAUTHENTICATED');
  const id=randomUUID();
  return withSecurityContext({tenantId:id,actorUserId:actor},()=>transaction(this.db,async c=>{
   const {rows}=await c.query('INSERT INTO tenants(id,name,created_by) VALUES($1,$2,$3) RETURNING *',[id,name,actor]);
   await c.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')",[id,actor]);
   await c.query(`INSERT INTO tenant_tool_policies(tenant_id,tool_name,enabled,allowed_roles,risk_level,requires_approval)
    VALUES($1,'get_high_risk_transactions',true,ARRAY['owner','admin','member'],'low',false)`,[id]);
   await this.audit('tenant.create','tenant',id,'allow','CREATED',c);return rows[0];
  }));
 }
 async members() {await this.authorize('conversation:read');return (await this.db.query(`SELECT m.user_id,m.role,m.status,u.email,u.name
 FROM tenant_memberships m JOIN "user" u ON u.id=m.user_id WHERE m.tenant_id=$1`,[securityContext()?.tenantId])).rows;}
 async changeMember(userId:string,role:Role,status:'active'|'removed') {
  await this.authorize('member:manage');
  return transaction(this.db,async c=>{
   const ctx=securityContext()!;
   // Serialize all membership changes, including concurrent last-owner removals.
   await c.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[ctx.tenantId]);
   const acting=await this.role(c);if(!acting || !rolePermissions[acting].includes('member:manage')) throw new SecurityError(403,'FORBIDDEN');
   const previous=(await c.query('SELECT role,status FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2',[ctx.tenantId,userId])).rows[0];
   if(acting!=='owner' && (role==='owner' || previous?.role==='owner')) throw new SecurityError(403,'OWNER_REQUIRED');
   if(previous?.role==='owner' && previous.status==='active' && (role!=='owner'||status!=='active')) {
    const owners=await c.query("SELECT 1 FROM tenant_memberships WHERE tenant_id=$1 AND role='owner' AND status='active'",[ctx.tenantId]);
    if(owners.rowCount===1) throw new SecurityError(409,'LAST_OWNER');
   }
   await c.query(`INSERT INTO tenant_memberships(tenant_id,user_id,role,status) VALUES($1,$2,$3,$4)
    ON CONFLICT(tenant_id,user_id) DO UPDATE SET role=$3,status=$4`,[ctx.tenantId,userId,role,status]);
   await this.audit('member.change','user',userId,'allow','MEMBERSHIP_UPDATED',c);
  });
 }
 async policies() {await this.authorize('conversation:read');return (await this.db.query('SELECT * FROM tenant_tool_policies WHERE tenant_id=$1',[securityContext()?.tenantId])).rows;}
 async setPolicy(policy:Omit<ToolPolicy,'policy_version'>) {
  await this.authorize('tool:manage');
  if(policy.tool_name!=='get_high_risk_transactions') throw new SecurityError(400,'UNKNOWN_TOOL');
  return transaction(this.db,async c=>{
   await c.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[securityContext()?.tenantId]);
   await this.authorize('tool:manage',c);
   await c.query(`INSERT INTO tenant_tool_policies(tenant_id,tool_name,enabled,allowed_roles,risk_level,requires_approval)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,tool_name) DO UPDATE SET enabled=$3,allowed_roles=$4,risk_level=$5,
    requires_approval=$6,policy_version=tenant_tool_policies.policy_version+1`,[securityContext()?.tenantId,policy.tool_name,policy.enabled,policy.allowed_roles,policy.risk_level,policy.requires_approval]);
   await this.audit('tool.policy.change','tool',policy.tool_name,'allow','POLICY_UPDATED',c);
  });
 }
 async setTenant(status:'active'|'disabled') {await this.authorize('tenant:manage');return transaction(this.db,async c=>{
  await c.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[securityContext()?.tenantId]);
  await this.authorize('tenant:manage',c);
  await c.query('UPDATE tenants SET status=$2 WHERE id=$1',[securityContext()?.tenantId,status]);
  await this.audit('tenant.change','tenant',securityContext()?.tenantId??null,'allow','STATUS_UPDATED',c);
 });}
 async authorizeTool(name:string,rawArguments?:string,context?:{approval?:ApprovalGrant}) {
  const ctx=securityContext();
  let role: Role | null;
  let policy: ToolPolicy | undefined;
  try {
   const row=(await this.db.query<ToolPolicy & { actor_role: Role | null }>(
    'SELECT p.*,eap_role($1,$2) AS actor_role FROM tenant_tool_policies p WHERE p.tenant_id=$1 AND p.tool_name=$3',
    [ctx?.tenantId,ctx?.actorUserId,name])).rows[0];
   policy=row; role=row?.actor_role ?? null;
  } catch {
   log('error','security.authorization_unavailable',{error_code:'AUTHORIZATION_UNAVAILABLE'});
   throw new SecurityError(503,'AUTHORIZATION_UNAVAILABLE');
  }
  let approved=false;
  if(policy?.requires_approval && context?.approval && rawArguments){
   const a=context.approval;
   try {approved=!!(await this.db.query(`SELECT 1 FROM agent_approvals a JOIN agent_jobs j ON j.id=a.job_id JOIN tool_executions e ON e.run_id=a.run_id AND e.tool_call_id=a.tool_call_id
    WHERE a.id=$1 AND a.tenant_id=$2 AND a.requested_by_user_id=$3 AND a.job_id=$4 AND a.tool_call_id=$5 AND a.tool_name=$6
    AND a.tool_arguments_hash=$7 AND a.checkpoint_version=$8 AND a.policy_version=$9 AND a.status='approved' AND a.expires_at>clock_timestamp()
    AND a.consumed_by_lease=$10 AND j.lease_token=$10 AND j.status='running' AND j.lease_expires_at>clock_timestamp() AND j.cancel_requested_at IS NULL AND e.status='running'`,
    [a.id,ctx?.tenantId,ctx?.actorUserId,a.jobId,a.callId,name,argumentsHash(rawArguments),a.checkpointVersion,policy.policy_version,a.leaseToken])).rowCount;}
   catch {throw new SecurityError(503,'AUTHORIZATION_UNAVAILABLE');}
  }
  const allowed=!!role && rolePermissions[role].includes('tool:execute') && !!policy?.enabled && policy.allowed_roles.includes(role) && (!policy.requires_approval || approved);
  // Deliberately fail closed for every tool, including read-only/low risk.
  // No name heuristic or implicit fail-open path can weaken a policy.
  try {
   await this.audit('tool.execute','tool',/^[a-z][a-z0-9_]{0,79}$/.test(name)?name:null,allowed?'allow':'deny',allowed?'POLICY_ALLOWED':'TOOL_FORBIDDEN');
   if(!allowed && context?.approval) await this.audit('approval.execution_denied','approval',context.approval.id,'deny','TOOL_FORBIDDEN');
  } catch {
   log('error','security.audit_unavailable',{error_code:'AUDIT_UNAVAILABLE'});
   throw new SecurityError(503,'AUDIT_UNAVAILABLE');
  }
  if(!allowed) throw new SecurityError(403,'TOOL_FORBIDDEN');
  return {tenantId:ctx!.tenantId!,actorUserId:ctx!.actorUserId,policyVersion:policy!.policy_version};
 }
 async validateJob(job:{tenant_id?:string;actor_user_id?:string|null;authorization_context?:unknown;policy_version?:number},run:{tenant_id?:string;actor_user_id?:string|null}) {
  const ctx=securityContext();
  const auth=job.authorization_context as Record<string,unknown>|undefined;
  if(!ctx || !ctx.tenantId || ctx.tenantId!==job.tenant_id || run.tenant_id!==job.tenant_id || !job.actor_user_id || job.actor_user_id!==run.actor_user_id || ctx.actorUserId!==job.actor_user_id || auth?.tenant_id!==job.tenant_id || auth?.actor_user_id!==job.actor_user_id || auth?.version!==1) throw new SecurityError(403,'INVALID_JOB_AUTHORIZATION');
  await this.authorize('agent:execute');
 }
 async limit(key:string,max:number,seconds:number,client:Pool|PoolClient=this.db) {
  const digest=createHash('sha256').update(key).digest('hex');
  const {rows}=await client.query(`INSERT INTO security_rate_limits(key,window_start,count) VALUES($1,clock_timestamp(),1)
   ON CONFLICT(key) DO UPDATE SET count=CASE WHEN security_rate_limits.window_start<clock_timestamp()-$2*interval '1 second' THEN 1 ELSE security_rate_limits.count+1 END,
   window_start=CASE WHEN security_rate_limits.window_start<clock_timestamp()-$2*interval '1 second' THEN clock_timestamp() ELSE security_rate_limits.window_start END
   RETURNING count, GREATEST(1,ceil($2-extract(epoch FROM clock_timestamp()-window_start)))::int AS retry`,[digest,seconds]);
  if(rows[0].count>max) throw new SecurityError(429,'RATE_LIMITED',rows[0].retry);
 }
 async guardSubmission(client:PoolClient) {
  const ctx=securityContext();if(!ctx?.tenantId) throw new SecurityError(403,'FORBIDDEN');
  await client.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[ctx.tenantId]);
  await this.authorize('agent:execute',client);
  const active=await client.query("SELECT 1 FROM agent_runs WHERE tenant_id=$1 AND status IN ('pending','running','waiting_approval')",[ctx.tenantId]);
  if((active.rowCount??0)>=4) throw new SecurityError(429,'CONCURRENT_RUN_LIMIT',5);
 }
 async resourceDenied(type:string,id:string):Promise<never> {await this.audit('resource.access',type,id,'deny','RESOURCE_UNAVAILABLE');throw new SecurityError(404,'NOT_FOUND');}
}
export type { SecurityContext };
