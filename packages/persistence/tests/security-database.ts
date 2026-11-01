import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createTestDatabase } from './database';
import { scopedPool, assertRuntimeRole } from '../src/security-context';
export async function securityDatabase() {
 const database=await createTestDatabase();
 const login=`security_${randomUUID().replaceAll('-','')}`;
 const password=randomUUID();
 await database.pool.query(`CREATE ROLE "${login}" LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB PASSWORD '${password}'`);
 await database.pool.query(`GRANT eap_app,eap_worker,eap_auth TO "${login}"`);
 const url=new URL(process.env.TEST_DATABASE_URL!);url.username=login;url.password=password;
 const raw=new Pool({connectionString:url.toString(),options:`-c search_path=${database.schema}`,max:2});
 const auth=new Pool({connectionString:url.toString(),options:`-c search_path=${database.schema} -c role=eap_auth`,max:2});
 await assertRuntimeRole(raw);
 return {connectionString:url.toString(),admin:database.pool,raw,auth,app:scopedPool(raw,'eap_app'),worker:scopedPool(raw,'eap_worker'),schema:database.schema,
  async close(){await auth.end();await raw.end();await database.pool.query(`DROP ROLE "${login}"`);await database.close();}};
}
