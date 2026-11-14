import {spawn,execFileSync} from 'node:child_process';
import {randomUUID,randomBytes} from 'node:crypto';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile,chmod} from 'node:fs/promises';
import {createWriteStream,createReadStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {Pool} from 'pg';
import {securityDatabase} from '../../tests/security-database';
import {SecurityStore,withSecurityContext,JobLifecycle,AgentJobQueue,scopedPool} from '../../src/index';
import {KnowledgeStore,IngestionWorker} from '../../../knowledge/src/index';
import {encryptBackup,decryptBackup} from '../../src/backup';
import {root,artifacts,assertTestTarget,metadata,save} from './common';
const target=assertTestTarget();if(target.port!=='5544')throw new Error('RESTORE_DRILL_REQUIRES_DEDICATED_5544_CONTAINER');
const compose=['compose','-p','eap-day14','-f',resolve(root,'compose.day14-test.yaml')],service='postgres-reliability';
const container=execFileSync('docker',[...compose,'ps','-q',service],{encoding:'utf8'}).trim();if(!container)throw new Error('ISOLATED_CONTAINER_REQUIRED');
const inspect=JSON.parse(execFileSync('docker',['inspect',container],{encoding:'utf8'}))[0];if(inspect.Config.Labels['com.docker.compose.project']!=='eap-day14'||inspect.Mounts.some((m:{Type:string;Name?:string})=>m.Type==='volume'&&!m.Name?.startsWith('eap-day14_')))throw new Error('REFUSE_PERSISTENT_OR_BUSINESS_CONTAINER');
const dir=resolve(artifacts,'backup-restore');await mkdir(dir,{recursive:true,mode:0o700});await chmod(dir,0o700);const temp=await mkdtemp(resolve(tmpdir(),'eap-restore-')),destination=`reliability_restore_${randomUUID().replaceAll('-','')}`;
const db=await securityDatabase();db.admin.on('error',()=>{});db.auth.on('error',()=>{});let created=false;let restoreRaw:Pool|undefined;const results:{name:string;status:string}[]=[];let restoreMs:number|undefined,restartMs:number|undefined;
const exec=(args:string[])=>execFileSync('docker',[...compose,'exec','-T',service,...args],{stdio:['ignore','pipe','pipe']});
const as=<T>(tenant:string,actor:string,fn:()=>T)=>withSecurityContext({tenantId:tenant,actorUserId:actor},fn);
const check=(name:string,ok:boolean)=>{results.push({name,status:ok?'PASS':'FAIL'});if(!ok)throw new Error('RESTORE_ASSERTION_FAILED');};
async function digest(pool:Pool){const tables=(await pool.query("SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename",[db.schema])).rows;const values:Record<string,string>={};for(const {tablename} of tables){if(!/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(tablename))throw new Error('INVALID_TABLE');values[tablename]=(await pool.query(`SELECT md5(COALESCE(jsonb_agg(row ORDER BY row::text)::text,'[]')) AS digest FROM (SELECT to_jsonb(t) AS row FROM "${db.schema}"."${tablename}" t) q`)).rows[0].digest;}return values;}
try{
 for(const user of ['restore-a','restore-b'])await db.auth.query('INSERT INTO "user"(id,name,email) VALUES($1,$1,$2)',[user,`${user}@restore.invalid`]);const security=new SecurityStore(db.app);
 const a=(await withSecurityContext({actorUserId:'restore-a'},()=>security.createTenant('Restore A'))).id,b=(await withSecurityContext({actorUserId:'restore-b'},()=>security.createTenant('Restore B'))).id;
 const kb=await as(a,'restore-a',()=>new KnowledgeStore(db.app).createBase('Private policy'));await as(a,'restore-a',()=>new KnowledgeStore(db.app).upload({knowledge_base_id:kb.id,title:'Policy',mime_type:'text/plain',bytes:Buffer.from('Refund policy requires a receipt.')}));await new IngestionWorker(new KnowledgeStore(db.worker)).once();
 const run=await as(a,'restore-a',()=>new JobLifecycle(db.app,security).submit({requestKey:randomUUID(),messages:[{role:'user',content:'restore smoke'}]}));
 await db.admin.query('CREATE TABLE schema_migrations(version text PRIMARY KEY,applied_at timestamptz DEFAULT now())');for(const name of (await readdir(resolve(root,'packages/persistence/migrations'))).filter(f=>f.endsWith('.sql')))await db.admin.query('INSERT INTO schema_migrations(version) VALUES($1)',[name]);
 const original=await digest(db.admin),dump=resolve(temp,'snapshot.dump');
 const child=spawn('docker',[...compose,'exec','-T',service,'pg_dump','-U','eap','-d','eap_test','-Fc','--schema',db.schema],{stdio:['ignore','pipe','pipe']});const exited=new Promise<number|null>((r,j)=>{child.once('error',j);child.once('exit',r);});child.stderr.on('data',()=>{});await pipeline(child.stdout,createWriteStream(dump,{mode:0o600}));check('pg_dump',await exited===0);
 const encrypted=resolve(dir,`backup-${new Date().toISOString().replaceAll(':','-')}.dump.enc`),key=process.env.BACKUP_ENCRYPTION_KEY??randomBytes(32).toString('hex');await encryptBackup(dump,encrypted,key);const restoredDump=resolve(temp,'restore.dump');await decryptBackup(encrypted,restoredDump,key);check('authenticated_encryption',true);
 exec(['createdb','-U','eap',destination]);created=true;const started=performance.now();exec(['psql','-U','eap','-d',destination,'-v','ON_ERROR_STOP=1','-c','CREATE EXTENSION vector']);
 const restore=spawn('docker',[...compose,'exec','-T',service,'pg_restore','-U','eap','-d',destination,'--exit-on-error'],{stdio:['pipe','ignore','pipe']});const restored=new Promise<number|null>((r,j)=>{restore.once('error',j);restore.once('exit',r);});restore.stderr.on('data',()=>{});await pipeline(createReadStream(restoredDump),restore.stdin);check('pg_restore',await restored===0);
 const adminUrl=new URL(target);adminUrl.pathname='/'+destination;const admin=new Pool({connectionString:adminUrl.toString(),options:`-c search_path=${db.schema}`});
 try{check('all_table_data_digests',JSON.stringify(await digest(admin))===JSON.stringify(original));check('pgvector',!!(await admin.query("SELECT 1 FROM pg_extension WHERE extname='vector'")).rowCount);const missing=(await admin.query("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace WHERE s.nspname=$1 AND c.relkind='r' AND c.relname NOT IN ('user','session','account','verification','rateLimit','security_rate_limits','schema_migrations') AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)",[db.schema])).rows[0].n;check('FORCE_RLS',missing===0);
  const runtimeUrl=new URL(db.connectionString);runtimeUrl.pathname='/'+destination;restoreRaw=new Pool({connectionString:runtimeUrl.toString(),options:`-c search_path=${db.schema}`,max:2});const app=scopedPool(restoreRaw,'eap_app');
  check('own_tenant_restore_smoke',(await as(a,'restore-a',()=>new KnowledgeStore(app).search({query:'refund'}))).results.length>0);check('cross_tenant_isolation',(await as(b,'restore-b',()=>new KnowledgeStore(app).search({query:'refund'}))).results.length===0);check('no_identity_no_rows',(await app.query('SELECT * FROM agent_runs')).rowCount===0);
 }finally{await restoreRaw?.end();restoreRaw=undefined;await admin.end();}restoreMs=performance.now()-started;
 // Restart ONLY the disposable, validated container; queued job remains durable.
 const restartStart=performance.now();execFileSync('docker',[...compose,'restart',service],{stdio:'ignore'});for(let i=0;i<60;i++){try{await db.admin.query('SELECT 1');break;}catch{if(i===59)throw new Error('DATABASE_RECOVERY_TIMEOUT');await new Promise(r=>setTimeout(r,500));}}restartMs=performance.now()-restartStart;
 const queue=new AgentJobQueue(db.worker,true),job=(await queue.claim('after-database-restart'))!;check('queued_job_survives_database_restart',job?.run_id===run.id);check('post_restart_finalization',await as(a,'restore-a',()=>new JobLifecycle(db.worker).finalizeJob({jobId:job.id,leaseToken:job.lease_token,status:'completed'})));
 check('final_event_matches_state',(await db.admin.query("SELECT count(*)::int AS n FROM agent_events WHERE run_id=$1 AND event_type='done'",[run.id])).rows[0].n===1);
}catch{results.push({name:'drill',status:'FAIL'});process.exitCode=1;}
finally{await restoreRaw?.end();if(created)exec(['dropdb','-U','eap','--force',destination]);await db.close();await rm(temp,{recursive:true,force:true});await save('backup-restore',{...await metadata('backup-restore-drill'),status:results.some(r=>r.status==='FAIL')?'FAIL':'PASS',results,restore_ms:restoreMs??null,database_restart_recovery_ms:restartMs??null,backup_scope:'isolated-fixture-only',encryption:'AES-256-GCM',key_retained:!!process.env.BACKUP_ENCRYPTION_KEY,rpo:'Snapshot logical backup; not zero loss, no WAL/PITR guarantee.',rto:'Measured fixture restore duration only, not a production RTO commitment.',retention:'Encrypted artifacts are private and gitignored; use backup:retention review before explicit pruning.'});}
console.log(JSON.stringify({results,restore_ms:restoreMs,database_restart_recovery_ms:restartMs}));
