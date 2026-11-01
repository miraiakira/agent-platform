import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient } from 'pg';
export interface SecurityContext { tenantId?: string; actorUserId: string; }
// HMR must share the same context with the cached scoped pool. Never pair a
// newly loaded ALS with a pool still consulting an older module's ALS.
const contextKey = Symbol.for('eap.security.context.v1');
const shared = globalThis as typeof globalThis & { [contextKey]?: AsyncLocalStorage<SecurityContext> };
const context = shared[contextKey] ??= new AsyncLocalStorage<SecurityContext>();
export const securityContext = () => context.getStore();
export function withSecurityContext<T>(value: SecurityContext, fn: () => T): T { return context.run(Object.freeze({...value}), fn); }
/** Connection-local role + transaction-local identity. Never SET session-wide tenant state. */
export function scopedPool(raw: Pool, role: 'eap_app'|'eap_worker'): Pool {
  async function connect() {
    const client = await raw.connect();
    let transaction = false;
    const identity = securityContext();
    async function begin() {
      await client.query('BEGIN');
      transaction = true;
      await client.query(`SET LOCAL ROLE ${role}`);
      await client.query("SELECT set_config('eap.tenant_id',$1,true),set_config('eap.actor_id',$2,true)", [identity?.tenantId ?? '',identity?.actorUserId ?? '']);
    }
    const proxy = new Proxy(client, { get(target, prop) {
      if (prop === 'release') return (error?: Error|boolean) => {
        // Callers must finish a transaction; destroy instead of leaking a dirty connection.
        client.release(transaction ? true : error);
      };
      if (prop === 'query') return async (sql: string, values?: unknown[]) => {
        const command = typeof sql === 'string' ? sql.trim().toUpperCase() : '';
        if (command === 'BEGIN') { if (transaction) throw new Error('Nested transaction'); await begin(); return; }
        if (command === 'COMMIT' || command === 'ROLLBACK') {
          try { return await client.query(sql,values); } finally { transaction = false; }
        }
        if (!transaction) throw new Error('Scoped connection requires a transaction');
        return client.query(sql,values);
      };
      const value = Reflect.get(target,prop); return typeof value === 'function' ? value.bind(target) : value;
    }});
    return proxy as PoolClient;
  }
  return new Proxy(raw, { get(target,prop) {
    if(prop==='connect') return connect;
    if(prop==='query') return async (sql:string,values?:unknown[]) => {
      const client=await connect();
      try { await client.query('BEGIN'); const result=await client.query(sql,values); await client.query('COMMIT'); return result; }
      catch(error) { await client.query('ROLLBACK'); throw error; } finally {client.release();}
    };
    const value=Reflect.get(target,prop); return typeof value==='function'?value.bind(target):value;
  }});
}
export async function assertRuntimeRole(pool: Pool) {
  const {rows}=await pool.query(`SELECT r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,
    pg_has_role(r.rolname,'eap_owner','MEMBER') AS owner FROM pg_roles r WHERE rolname=current_user OR rolname IN ('eap_app','eap_worker','eap_auth')`);
  if(!rows.length || rows.some(r=>r.rolsuper || r.rolbypassrls || r.rolcreaterole || r.rolcreatedb || r.owner)) throw new Error('Runtime database identity must be non-owner, NOSUPERUSER, NOBYPASSRLS, NOCREATEROLE, NOCREATEDB');
}
