import {createHash} from 'node:crypto';
import {Pool} from 'pg';
import {readdir,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {configurationFingerprint,configurationChecks,readinessPassed,type ReadinessCheck} from '../../src/reliability';
import {assertRuntimeRole} from '../../src/security-context';
import {fingerprint,metadata,save,root,artifacts} from './common';
const checks=configurationChecks(process.env),schema=process.env.READINESS_SCHEMA??'public';
const add=(id:string,ok:boolean|null,reason:string)=>checks.push({id,critical:true,grade:ok===null?'WARN':ok?'PASS':'FAIL',verification:ok===null?'NOT VERIFIED':ok?'VERIFIED':'FAILED',reason});
if(process.env.READINESS_DATABASE_URL&&/^[a-z_][a-z0-9_]*$/.test(schema)){
 const pool=new Pool({connectionString:process.env.READINESS_DATABASE_URL,max:1,connectionTimeoutMillis:2000,statement_timeout:3000});
 try{
  await pool.query('SET default_transaction_read_only=on');
  const expected=(await readdir(resolve(root,'packages/persistence/migrations'))).filter(f=>f.endsWith('.sql')).sort();
  const tables=(await pool.query('SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind=\'r\'',[schema])).rows;
  const scoped=tables.filter(t=>!['schema_migrations','user','session','account','verification','rateLimit','security_rate_limits'].includes(t.relname));
  add('DATABASE_FORCE_RLS',scoped.length>0&&scoped.every(t=>t.relrowsecurity&&t.relforcerowsecurity),'All scoped application tables must enable and FORCE RLS.');
  const applied=(await pool.query(`SELECT version FROM "${schema}".schema_migrations`)).rows.map(r=>r.version);add('DATABASE_MIGRATIONS',expected.every(f=>applied.includes(f)),'All repository migrations must have recorded application.');
  add('PGVECTOR',!!(await pool.query("SELECT 1 FROM pg_extension WHERE extname='vector'")).rowCount,'pgvector extension exists.');
  add('AUDIT_APPEND_ONLY',!!(await pool.query("SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='audit_logs' AND t.tgname='immutable_audit' AND t.tgenabled='O'",[schema])).rowCount,'Required audit trigger enabled.');
  const workers=(await pool.query(`SELECT count(*)::int AS n FROM "${schema}".worker_heartbeats WHERE seen_at>clock_timestamp()-interval '30 seconds'`)).rows[0].n;add('WORKER_HEALTH',workers>0,'At least one recent worker heartbeat required.');
 }catch{add('DATABASE_INSPECTION',false,'Inspection failed; no database details or credentials emitted.');}finally{await pool.end();}
}else add('DATABASE_INSPECTION',null,'Set read-only inspection credentials and an explicit schema.');
if(process.env.DATABASE_URL){const p=new Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:2000,statement_timeout:2000});try{await assertRuntimeRole(p);add('RUNTIME_DB_IDENTITY',true,'Runtime identity is restricted and not an owner.');}catch{add('RUNTIME_DB_IDENTITY',false,'Runtime identity restriction could not be verified.');}finally{await p.end();}}else add('RUNTIME_DB_IDENTITY',null,'Runtime database identity unavailable.');
for(const name of ['faults','regression','load/smoke','backup-restore']){
 try{const r=JSON.parse(await readFile(resolve(process.env.READINESS_EVIDENCE_DIR??artifacts,name,'report.json'),'utf8'));const fresh=Date.now()-new Date(r.generated_at).getTime()<86400000&&new Date(r.generated_at).getTime()<=Date.now()+5000;const pass=r.status==='PASS'||r.results?.length>0&&r.results.every((x:{status:string})=>x.status==='PASS');add(`EVIDENCE_${name}`,fresh&&r.source_sha256===await fingerprint()&&pass,'Evidence must be fresh, successful and match current source.');}catch{add(`EVIDENCE_${name}`,null,'Required actual execution evidence is missing.');}
}
const configurationSha=configurationFingerprint(process.env);
let manual: {source_sha256:string;configuration_sha256:string;reviewer:string;approved_at:string;checks:{id:string;evidence_file:string;sha256:string}[]}|undefined;
if(process.env.READINESS_MANUAL_REVIEW_FILE){try{manual=JSON.parse(await readFile(process.env.READINESS_MANUAL_REVIEW_FILE,'utf8'));}catch{add('MANUAL_REVIEW_FORMAT',false,'Manual review document could not be read.');}}
for(const id of ['DEPLOYED_AUTH_COOKIE_CSRF','OBSERVABILITY_DELIVERY_AND_ALERTS','PRODUCTION_BACKUP_SCHEDULE_AND_RESTORE','PRODUCTION_CAPACITY_PLAN','DEPENDENCY_AND_CONTAINER_SECURITY_REVIEW']){
 const item=manual?.checks?.find(c=>c.id===id);let verified=false;
 if(item&&manual?.reviewer&&manual.source_sha256===await fingerprint()&&manual.configuration_sha256===configurationSha&&Date.now()-new Date(manual.approved_at).getTime()<86400000&&new Date(manual.approved_at).getTime()<=Date.now()){
  try{const bytes=await readFile(item.evidence_file);verified=createHash('sha256').update(bytes).digest('hex')===item.sha256;}catch{}
 }
 add(id,verified?true:null,verified?'Explicit trusted-operator manual attestation; attachment integrity checked, not automatic security proof.':'MANUAL REVIEW: isolated fixtures do not verify this production property.');
}
const passed=readinessPassed(checks),report={...await metadata('production-readiness'),scope:'production-readiness',configuration_sha256:configurationSha,status:passed?'PASS':'FAIL',checks,notes:['Proposed SLOs are not achieved production SLOs.','Critical NOT VERIFIED items block release; no development or Mock evidence silently approves production.']};await save('readiness',report,`# Production Readiness\n\nResult: ${report.status}\n\n| Check | Grade | Verification | Reason |\n|---|---|---|---|\n${checks.map(c=>`| ${c.id} | ${c.grade} | ${c.verification} | ${c.reason} |`).join('\n')}\n`);console.log(JSON.stringify({status:report.status,checks}));if(!passed)process.exitCode=1;
