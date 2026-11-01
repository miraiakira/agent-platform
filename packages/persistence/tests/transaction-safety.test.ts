import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Pool, type PoolClient } from 'pg';
import { securityDatabase } from './security-database';
import { SecurityStore } from '../src/security';
import { PersistenceStore } from '../src/store';
import { scopedPool, withSecurityContext, withTenantTransaction } from '../src/security-context';
import { transaction } from '../src/transaction';

describe('real PostgreSQL scoped transaction lifecycle', () => {
  let db: Awaited<ReturnType<typeof securityDatabase>>;
  let physical: Pool, pool: Pool, store: PersistenceStore;
  let a: string, b: string;
  const extraPools: Pool[] = [];
  const as = <T>(tenantId: string, actorUserId: string, fn: () => T) => withSecurityContext({ tenantId, actorUserId }, fn);
  beforeEach(async () => {
    db = await securityDatabase();
    for (const user of ['alice', 'bob']) await db.auth.query('INSERT INTO "user"(id,name,email) VALUES($1,$1,$2)', [user, `${user}@test.example`]);
    const security = new SecurityStore(db.app);
    a = (await withSecurityContext({ actorUserId: 'alice' }, () => security.createTenant('A'))).id;
    b = (await withSecurityContext({ actorUserId: 'bob' }, () => security.createTenant('B'))).id;
    physical = new Pool({ connectionString: db.connectionString, options: `-c search_path=${db.schema}`, max: 1 });
    // Idle socket failures belong to pg.Pool; checked-out failures are handled by the facade.
    physical.on('error', () => {});
    pool = scopedPool(physical, 'eap_app'); store = new PersistenceStore(pool);
    await as(a, 'alice', () => store.createConversation('A-only'));
    await as(b, 'bob', () => store.createConversation('B-only'));
    await db.admin.query(`CREATE TABLE commit_probe (id uuid PRIMARY KEY, parent uuid REFERENCES commit_probe(id) DEFERRABLE INITIALLY DEFERRED)`);
    await db.admin.query('GRANT SELECT,INSERT ON commit_probe TO eap_app');
  });
  afterEach(async () => { await Promise.all(extraPools.splice(0).map(p => p.end())); await physical?.end(); await db?.close(); });
  const pid = () => as(a, 'alice', async () => (await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number);
  async function assertIsolated() {
    expect((await as(a, 'alice', () => store.listConversations())).map(r => r.title).sort()).toEqual(['A-only']);
    expect((await as(b, 'bob', () => store.listConversations())).map(r => r.title).sort()).toEqual(['B-only']);
    expect(await store.listConversations()).toEqual([]);
    const raw = (await physical.query("SELECT current_user=session_user AS reset, current_setting('eap.tenant_id',true) AS tenant, current_setting('eap.actor_id',true) AS actor")).rows[0];
    expect(raw.reset).toBe(true); expect(raw.tenant ?? '').toBe(''); expect(raw.actor ?? '').toBe('');
  }
  it('commits on one real connection and clears LOCAL identity before reuse', async () => {
    const before = await pid(); const id = randomUUID();
    const result = await withTenantTransaction(pool, { tenantId: a, actorUserId: 'alice' }, async c => {
      const ctx = (await c.query("SELECT current_setting('eap.tenant_id') AS tenant,pg_backend_pid() AS pid")).rows[0];
      expect(ctx).toEqual({ tenant: a, pid: before });
      await c.query('INSERT INTO conversations(id,title) VALUES($1,$2)', [id, 'committed']); return id;
    });
    expect(result).toBe(id); expect((await as(a, 'alice', () => store.getConversation(id)))?.title).toBe('committed');
    expect(await as(b, 'bob', () => store.getConversation(id))).toBeNull(); expect(await pid()).toBe(before);
    expect((await physical.query("SELECT current_setting('eap.tenant_id',true) AS tenant")).rows[0].tenant).toBe('');
  });
  it('supports comments, whitespace, semicolons and QueryConfig without bypassing control', async () => {
    await as(a, 'alice', async () => {
      const c = await pool.connect();
      try {
        await c.query({ text: ' /* outer /* nested */ */ BeGiN TRANSACTION; -- start' });
        await c.query('INSERT INTO conversations(id,title) VALUES($1,$2)', [randomUUID(), 'rolled-back']);
        await c.query({ text: '\n rollback /* end */ work ; -- safe' });
        await expect(c.query('SELECT * FROM conversations')).rejects.toMatchObject({ code: 'SCOPED_TRANSACTION_REQUIRED' });
      } finally { c.release(); }
    });
    await assertIsolated();
  });
  it('rolls back SQL errors and safely reuses the same backend', async () => {
    const before = await pid();
    await expect(as(a, 'alice', () => transaction(pool, async c => { await c.query('INSERT INTO conversations(id,title) VALUES($1,$2)', [randomUUID(), 'uncommitted']); await c.query('SELECT 1/0'); }))).rejects.toMatchObject({ code: '22012' });
    expect(await pid()).toBe(before); await assertIsolated();
  });
  it('never reports a swallowed SQL error as a successful COMMIT', async () => {
    await expect(as(a, 'alice', () => transaction(pool, async c => { try { await c.query('SELECT 1/0'); } catch { /* Simulate caller swallowing a statement failure. */ } return 'not committed'; }))).rejects.toMatchObject({ code: 'SCOPED_TRANSACTION_NOT_COMMITTED' });
    await assertIsolated();
  });
  it('rejects a real deferred-constraint COMMIT and destroys that connection', async () => {
    let failedPid = 0;
    await expect(withTenantTransaction(pool, { tenantId: a, actorUserId: 'alice' }, async c => {
      failedPid = (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await c.query('INSERT INTO conversations(id,title) VALUES($1,$2)', [randomUUID(), 'failed-commit']);
      await c.query('INSERT INTO commit_probe(id,parent) VALUES($1,$2)', [randomUUID(), randomUUID()]);
    })).rejects.toMatchObject({ code: '23503' });
    expect(await pid()).not.toBe(failedPid); expect((await db.admin.query('SELECT 1 FROM commit_probe')).rowCount).toBe(0);
    await assertIsolated();
  });
  it('preserves the original failure and destroys the connection when ROLLBACK cannot reach PostgreSQL', async () => {
    const original = new Error('business failure'); let killed = 0;
    await expect(withTenantTransaction(pool, { tenantId: a, actorUserId: 'alice' }, async c => {
      killed = (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await c.query('INSERT INTO conversations(id,title) VALUES($1,$2)', [randomUUID(), 'must-rollback']);
      expect((await db.admin.query('SELECT pg_terminate_backend($1) AS killed', [killed])).rows[0].killed).toBe(true);
      throw original;
    })).rejects.toBe(original);
    expect(await pid()).not.toBe(killed); await assertIsolated();
  });
  it('survives a real connection interruption during a query and reacquires an isolated backend', async () => {
    let killed = 0;
    await expect(withTenantTransaction(pool, { tenantId: a, actorUserId: 'alice' }, async c => {
      killed = (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const waiting = c.query('SELECT pg_sleep(10)'); void waiting.catch(() => {});
      await db.admin.query('SELECT pg_terminate_backend($1)', [killed]); await waiting;
    })).rejects.toThrow();
    expect(await pid()).not.toBe(killed); await assertIsolated();
  });
  it('discards a terminated idle backend and reconnects without losing tenant isolation', async () => {
    const before = await pid(); const discarded = once(physical, 'error');
    await db.admin.query('SELECT pg_terminate_backend($1)', [before]); await discarded;
    expect(await pid()).not.toBe(before); await assertIsolated();
  });
  it('destroys an abandoned transaction instead of returning LOCAL identity to the pool', async () => {
    let abandoned = 0;
    await as(a, 'alice', async () => { const c = await pool.connect(); await c.query('BEGIN'); abandoned = (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; await c.query('INSERT INTO conversations(id,title) VALUES($1,$2)', [randomUUID(), 'abandoned']); c.release(); });
    expect(await pid()).not.toBe(abandoned); await assertIsolated();
  });
  it('never revives a released client after an in-flight query settles', async () => {
    const before = await pid();
    await as(a, 'alice', async () => {
      const c = await pool.connect(); await c.query('BEGIN');
      const pending = c.query('SELECT pg_sleep(0.03)'); void pending.catch(() => {});
      c.release(); await Promise.allSettled([pending]);
      await expect(c.query('BEGIN')).rejects.toMatchObject({ code: 'SCOPED_CLIENT_RELEASED' });
      expect(() => c.release()).toThrow('SCOPED_CLIENT_RELEASED');
    });
    expect(await pid()).not.toBe(before); await assertIsolated();
  });
  it('does not permit transaction SQL or saved clients to escape an explicit callback', async () => {
    let saved: PoolClient | undefined;
    await withTenantTransaction(pool, { tenantId: a, actorUserId: 'alice' }, async c => {
      saved = c;
      await expect(c.query('INSERT INTO conversations(id,title) VALUES($1,$2)', [randomUUID(), 'callback-must-not-run'], () => {})).rejects.toMatchObject({ code: 'SCOPED_QUERY_UNSUPPORTED' });
      await expect(c.query({ text: '/* bypass */ COMMIT;' })).rejects.toMatchObject({ code: 'SCOPED_TRANSACTION_CONTROL_FORBIDDEN' });
      expect((await c.query('SELECT current_setting(\'eap.tenant_id\') AS tenant')).rows[0].tenant).toBe(a);
    });
    await expect(as(a, 'alice', () => saved!.query('SELECT * FROM conversations'))).rejects.toThrow(); await assertIsolated();
  });
  it.each(['COMMIT AND CHAIN', 'START TRANSACTION', 'END;', 'ABORT;', 'ROLLBACK TO SAVEPOINT x'])('rejects unsupported control syntax before execution: %s', async sql => {
    await as(a, 'alice', async () => { const c = await pool.connect(); try { await c.query('BEGIN'); await expect(c.query(sql)).rejects.toMatchObject({ code: 'SCOPED_SQL_UNSUPPORTED' }); expect((await c.query('SELECT current_setting(\'eap.tenant_id\') AS tenant')).rows[0].tenant).toBe(a); await c.query('ROLLBACK'); } finally { c.release(); } });
    await assertIsolated();
  });
  it('rejects multi-statement SQL before an INSERT or embedded COMMIT executes', async () => {
    await expect(as(a, 'alice', () => pool.query({ text: "INSERT INTO conversations(id,title) VALUES(gen_random_uuid(),'escaped'); COMMIT; SELECT 1" }))).rejects.toMatchObject({ code: '42601' });
    await assertIsolated();
  });
  it('rejects a client borrowed by a different tenant async context', async () => {
    await withTenantTransaction(pool, { tenantId: a, actorUserId: 'alice' }, async c => {
      await expect(as(b, 'bob', () => c.query('SELECT * FROM conversations'))).rejects.toMatchObject({ code: 'SCOPED_CONTEXT_MISMATCH' });
      expect((await c.query('SELECT title FROM conversations')).rows.map(r => r.title)).toEqual(['A-only']);
    });
    await assertIsolated();
  });
  it('isolates simultaneously active Tenant A/B transactions on different physical connections', async () => {
    const raw = new Pool({ connectionString: db.connectionString, options: `-c search_path=${db.schema}`, max: 2 }); extraPools.push(raw);
    const concurrent = scopedPool(raw, 'eap_app'); let entered = 0; let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const results = await Promise.all([[a, 'alice', 'A-only'], [b, 'bob', 'B-only']].map(([tenantId, actorUserId, title]) => withTenantTransaction(concurrent, { tenantId, actorUserId: actorUserId! }, async c => {
      const id = (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; if (++entered === 2) release(); await barrier;
      expect((await c.query('SELECT title FROM conversations')).rows.map(r => r.title)).toEqual([title]); return id;
    })));
    expect(new Set(results).size).toBe(2); await assertIsolated();
  });
  it('destroys connections after BEGIN role/context setup fails', async () => {
    const before = await pid(); const login = new URL(db.connectionString).username;
    await db.admin.query(`REVOKE eap_app FROM "${login}"`);
    try { await expect(as(a, 'alice', () => store.listConversations())).rejects.toMatchObject({ code: '42501' }); }
    finally { await db.admin.query(`GRANT eap_app TO "${login}"`); }
    expect(await pid()).not.toBe(before); await assertIsolated();
  });
  it('defaults to no resource access without a context, including after prior tenant use', async () => {
    await assertIsolated(); await expect(store.createConversation('no tenant')).rejects.toMatchObject({ code: '42501' }); await assertIsolated();
  });
});
