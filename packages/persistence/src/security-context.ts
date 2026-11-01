import { AsyncLocalStorage } from 'node:async_hooks';
import { log } from '@eap/observability';
import type { Pool, PoolClient, QueryConfig } from 'pg';
export interface SecurityContext { tenantId?: string; actorUserId: string; }
// HMR must share the same context with the cached scoped pool. Never pair a
// newly loaded ALS with a pool still consulting an older module's ALS.
const contextKey = Symbol.for('eap.security.context.v1');
const shared = globalThis as typeof globalThis & { [contextKey]?: AsyncLocalStorage<SecurityContext> };
const context = shared[contextKey] ??= new AsyncLocalStorage<SecurityContext>();
export const securityContext = () => context.getStore();
export function withSecurityContext<T>(value: SecurityContext, fn: () => T): T { return context.run(Object.freeze({...value}), fn); }

export class ScopedTransactionError extends Error {
  constructor(readonly code: string) { super(code); }
}
type QueryInput = string | QueryConfig<unknown[]>;
type TransactionCallback<T> = (client: PoolClient) => Promise<T>;
const transactionKey = Symbol.for('eap.scoped-pool.transaction.v1');
const idleGuardKey = Symbol.for('eap.scoped-pool.idle-guard.v1');
const poolGlobals = globalThis as typeof globalThis & { [idleGuardKey]?: WeakSet<Pool> };
const guardedPools = poolGlobals[idleGuardKey] ??= new WeakSet<Pool>();
type ManagedPool = Pool & { [transactionKey]?: <T>(fn: TransactionCallback<T>) => Promise<T> };

// Only inspect statement boundaries here, not business SQL. PostgreSQL's extended
// protocol rejects multi-statement queries before executing any statement.
function skipTrivia(sql: string, start = 0): number {
  let pos = start;
  while (pos < sql.length) {
    if (/\s/.test(sql[pos]!)) { pos++; continue; }
    if (sql.startsWith('--', pos)) { while (pos < sql.length && !/[\r\n]/.test(sql[pos]!)) pos++; continue; }
    if (sql.startsWith('/*', pos)) {
      let depth = 1; pos += 2;
      while (pos < sql.length && depth) {
        if (sql.startsWith('/*', pos)) { depth++; pos += 2; }
        else if (sql.startsWith('*/', pos)) { depth--; pos += 2; }
        else pos++;
      }
      if (depth) throw new ScopedTransactionError('SCOPED_SQL_UNSUPPORTED');
      continue;
    }
    break;
  }
  return pos;
}
function statementKind(sql: string): string {
  const first = /^[a-z]+/i.exec(sql.slice(skipTrivia(sql)))?.[0].toUpperCase();
  if (!first) throw new ScopedTransactionError('SCOPED_SQL_UNSUPPORTED');
  if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(first)) {
    const words: string[] = []; let pos = 0;
    while ((pos = skipTrivia(sql, pos)) < sql.length) {
      if (sql[pos] === ';') { if (skipTrivia(sql, pos + 1) !== sql.length) break; return validControl(words); }
      const word = /^[a-z]+/i.exec(sql.slice(pos));
      if (!word) break;
      words.push(word[0].toUpperCase()); pos += word[0].length;
    }
    if (pos === sql.length) return validControl(words);
    throw new ScopedTransactionError('SCOPED_SQL_UNSUPPORTED');
  }
  if (!['SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE', 'VALUES', 'SHOW', 'EXPLAIN'].includes(first)) {
    throw new ScopedTransactionError('SCOPED_SQL_UNSUPPORTED');
  }
  return 'query';
}
function validControl(words: string[]) {
  if (words.length === 1 || (words.length === 2 && ['WORK', 'TRANSACTION'].includes(words[1]!))) return words[0]!;
  throw new ScopedTransactionError('SCOPED_SQL_UNSUPPORTED');
}

/** Promise-only facade for the existing repositories. The manager alone owns
 * BEGIN/COMMIT/ROLLBACK, and never exposes the underlying client/connection. */
export function scopedPool(raw: Pool, role: 'eap_app' | 'eap_worker', beforeCheckout?: () => Promise<void>): Pool {
  if (role !== 'eap_app' && role !== 'eap_worker') throw new ScopedTransactionError('SCOPED_ROLE_INVALID');
  // pg.Pool removes failed idle clients before emitting this event. Keep the
  // error observable without an unhandled EventEmitter error crashing the service.
  if (!guardedPools.has(raw)) {
    raw.on('error', () => log('error', 'database.connection_discarded', { error_code: 'DATABASE_CONNECTION_LOST' }));
    guardedPools.add(raw);
  }
  async function checkout() {
    await beforeCheckout?.();
    const client = await raw.connect();
    const identity = securityContext();
    let phase: 'idle' | 'starting' | 'active' | 'failed' | 'ending' | 'broken' | 'released' = 'idle';
    let poisoned = false;
    let released = false;
    let pending = 0;
    const broken = () => { poisoned = true; if (!released) phase = 'broken'; };
    client.on('error', broken);
    const failed = () => { if (!released && phase !== 'broken') phase = 'failed'; };
    function noPending() { if (pending) { poisoned = true; throw new ScopedTransactionError('SCOPED_QUERY_PENDING'); } }
    function checkIdentity() {
      if (released) throw new ScopedTransactionError('SCOPED_CLIENT_RELEASED');
      const active = securityContext();
      if (active?.tenantId !== identity?.tenantId || active?.actorUserId !== identity?.actorUserId) throw new ScopedTransactionError('SCOPED_CONTEXT_MISMATCH');
    }
    async function begin() {
      checkIdentity();
      if (phase !== 'idle' || poisoned) throw new ScopedTransactionError('SCOPED_TRANSACTION_STATE');
      phase = 'starting';
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL ROLE ${role}`);
        await client.query("SELECT set_config('eap.tenant_id',$1,true),set_config('eap.actor_id',$2,true)", [identity?.tenantId ?? '', identity?.actorUserId ?? '']);
        phase = 'active';
      } catch (error) { poisoned = true; failed(); throw error; }
    }
    async function commit() {
      checkIdentity();
      noPending();
      if (phase !== 'active' || poisoned) throw new ScopedTransactionError('SCOPED_TRANSACTION_NOT_COMMITTED');
      phase = 'ending';
      try {
        const result = await client.query('COMMIT');
        if (result.command !== 'COMMIT') throw new ScopedTransactionError('SCOPED_TRANSACTION_NOT_COMMITTED');
        phase = 'idle'; return result;
      } catch (error) { poisoned = true; failed(); throw error; }
    }
    async function rollback() {
      noPending();
      if (released || phase === 'broken') throw new ScopedTransactionError('SCOPED_CONNECTION_UNUSABLE');
      phase = 'ending';
      try {
        const result = await client.query('ROLLBACK');
        if (result.command !== 'ROLLBACK') throw new ScopedTransactionError('SCOPED_ROLLBACK_FAILED');
        phase = 'idle'; return result;
      } catch (error) { poisoned = true; phase = 'broken'; throw error; }
    }
    async function query(input: QueryInput, values?: unknown[], ...extra: unknown[]) {
      if (extra.length || (values !== undefined && !Array.isArray(values))) throw new ScopedTransactionError('SCOPED_QUERY_UNSUPPORTED');
      checkIdentity();
      if (phase !== 'active' || poisoned) throw new ScopedTransactionError('SCOPED_TRANSACTION_REQUIRED');
      const config = typeof input === 'string' ? { text: input, values } : { ...input, values: values ?? input.values };
      if (typeof config.text !== 'string' || (config.values !== undefined && !Array.isArray(config.values))) throw new ScopedTransactionError('SCOPED_QUERY_UNSUPPORTED');
      if (statementKind(config.text) !== 'query') throw new ScopedTransactionError('SCOPED_TRANSACTION_CONTROL_FORBIDDEN');
      pending++;
      try {
        return await client.query({ text: config.text, values: config.values, name: config.name, types: config.types, rowMode: 'rowMode' in config && config.rowMode === 'array' ? 'array' : undefined, queryMode: 'extended' } as QueryConfig<unknown[]>);
      } catch (error) { failed(); throw error; }
      finally { pending--; }
    }
    function release(error?: Error | boolean) {
      if (released) throw new ScopedTransactionError('SCOPED_CLIENT_RELEASED');
      const destroy = !!error || poisoned || phase !== 'idle' || pending > 0;
      released = true; phase = 'released';
      client.release(destroy);
      if (!destroy) client.removeListener('error', broken);
      else client.once('end', () => client.removeListener('error', broken));
    }
    // Explicit callbacks cannot close or release the manager's transaction.
    const owned = { query, release() { throw new ScopedTransactionError('SCOPED_TRANSACTION_OWNED'); } } as unknown as PoolClient;
    const compatible = { async query(input: QueryInput, values?: unknown[], ...extra: unknown[]) {
      if (extra.length || (values !== undefined && !Array.isArray(values))) throw new ScopedTransactionError('SCOPED_QUERY_UNSUPPORTED');
      const sql = typeof input === 'string' ? input : input.text;
      const kind = statementKind(sql);
      if (kind !== 'query' && (values?.length || (typeof input !== 'string' && input.values?.length))) throw new ScopedTransactionError('SCOPED_QUERY_UNSUPPORTED');
      if (kind === 'BEGIN') return begin();
      if (kind === 'COMMIT') return commit();
      if (kind === 'ROLLBACK') return rollback();
      return query(input, values);
    }, release } as unknown as PoolClient;
    return { begin, commit, rollback, release, owned, compatible };
  }
  async function run<T>(fn: TransactionCallback<T>): Promise<T> {
    const handle = await checkout();
    try { await handle.begin(); const result = await fn(handle.owned); await handle.commit(); return result; }
    catch (error) { try { await handle.rollback(); } catch { /* release destroys the untrusted connection; preserve the original failure. */ } throw error; }
    finally { handle.release(); }
  }
  return {
    [transactionKey]: run,
    query: async (input: QueryInput, values?: unknown[], ...extra: unknown[]) => {
      if (extra.length || (values !== undefined && !Array.isArray(values))) throw new ScopedTransactionError('SCOPED_QUERY_UNSUPPORTED');
      return run(client => client.query(input as string, values));
    },
    connect: async (...args: unknown[]) => {
      if (args.length) throw new ScopedTransactionError('SCOPED_QUERY_UNSUPPORTED');
      return (await checkout()).compatible;
    },
    end: () => raw.end(),
    get totalCount() { return raw.totalCount; },
    get idleCount() { return raw.idleCount; },
    get waitingCount() { return raw.waitingCount; },
  } as unknown as Pool;
}
export function scopedTransaction<T>(pool: Pool, fn: TransactionCallback<T>): Promise<T> | undefined {
  return (pool as ManagedPool)[transactionKey]?.(fn);
}
export function withTenantTransaction<T>(pool: Pool, identity: SecurityContext, fn: TransactionCallback<T>): Promise<T> {
  return withSecurityContext(identity, () => {
    const result = scopedTransaction(pool, fn);
    if (!result) throw new ScopedTransactionError('SCOPED_POOL_REQUIRED');
    return result;
  });
}
export async function assertRuntimeRole(pool: Pool) {
  const {rows}=await pool.query(`SELECT r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,
    pg_has_role(r.rolname,'eap_owner','MEMBER') AS owner FROM pg_roles r WHERE rolname=current_user OR rolname IN ('eap_app','eap_worker','eap_auth')`);
  if(!rows.length || rows.some(r=>r.rolsuper || r.rolbypassrls || r.rolcreaterole || r.rolcreatedb || r.owner)) throw new Error('Runtime database identity must be non-owner, NOSUPERUSER, NOBYPASSRLS, NOCREATEROLE, NOCREATEDB');
}
