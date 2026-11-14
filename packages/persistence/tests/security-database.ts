import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createTestDatabase } from './database';
import { scopedPool, assertRuntimeRole } from '../src/security-context';
import { cleanupSteps } from '../scripts/reliability/diagnostics';
export async function securityDatabase() {
 const database=await createTestDatabase();
 const login=`security_${randomUUID().replaceAll('-','')}`;
 const password=randomUUID();
 let raw:Pool|undefined,auth:Pool|undefined,roleCreated=false;
 const close=()=>cleanupSteps([
   {step:'auth_pool.end',run:async()=>{await auth?.end();}},
   {step:'raw_pool.end',run:async()=>{await raw?.end();}},
   {step:'role.drop',run:async()=>{if(roleCreated)await database.pool.query(`DROP ROLE "${login}"`);}},
   {step:'database.close',run:()=>database.close(),timeoutMs:20000},
 ]);
 try{
  const url=new URL(process.env.TEST_DATABASE_URL!);url.username=login;url.password=password;
  await database.pool.query(`CREATE ROLE "${login}" LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB PASSWORD '${password}'`);roleCreated=true;
  await database.pool.query(`GRANT eap_app,eap_worker,eap_auth TO "${login}"`);
  raw=new Pool({connectionString:url.toString(),options:`-c search_path=${database.schema}`,max:2,connectionTimeoutMillis:5000,query_timeout:5000});
  auth=new Pool({connectionString:url.toString(),options:`-c search_path=${database.schema} -c role=eap_auth`,max:2,connectionTimeoutMillis:5000,query_timeout:5000});
  await assertRuntimeRole(raw);
  return {connectionString:url.toString(),admin:database.pool,raw,auth,app:scopedPool(raw,'eap_app'),worker:scopedPool(raw,'eap_worker'),schema:database.schema,close};
 }catch(error){
  try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Security fixture setup and cleanup failed');}
  throw error;
 }
}
