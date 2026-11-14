import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,rm,writeFile,chmod} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {resolve} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {encryptBackup} from '../../src/backup';
import {initTelemetry,metric,shutdownTelemetry} from '@eap/observability';
let u:URL;try{u=new URL(process.env.BACKUP_DATABASE_URL??'');if(!/^postgres(?:ql)?:$/.test(u.protocol))throw new Error();}catch{throw new Error('BACKUP_DATABASE_URL_REQUIRED_OR_INVALID');}const local=['localhost','127.0.0.1'].includes(u.hostname);
if(!local&&(process.env.BACKUP_PRODUCTION_AUTHORIZED!=='true'||u.searchParams.get('sslmode')!=='verify-full'))throw new Error('EXPLICIT_PRODUCTION_BACKUP_AUTHORIZATION_AND_TLS_REQUIRED');
if(!process.env.BACKUP_DIRECTORY||!process.env.BACKUP_ENCRYPTION_KEY)throw new Error('BACKUP_DIRECTORY_AND_KEY_REQUIRED');
const dir=resolve(process.env.BACKUP_DIRECTORY);await mkdir(dir,{recursive:true,mode:0o700});await chmod(dir,0o700);const temp=await mkdtemp(resolve(dir,'.private-dump-'));initTelemetry({service:'eap-backup'});
try{
 const raw=resolve(temp,'snapshot.dump'),dest=resolve(dir,`backup-${new Date().toISOString().replaceAll(':','-')}-${randomUUID()}.dump.enc`);
 const child=spawn(process.env.PG_DUMP_BINARY??'pg_dump',['--format=custom','--no-password'],{env:{...process.env,PGHOST:u.hostname,PGPORT:u.port||'5432',PGUSER:decodeURIComponent(u.username),PGPASSWORD:decodeURIComponent(u.password),PGDATABASE:decodeURIComponent(u.pathname.slice(1)),PGSSLMODE:u.searchParams.get('sslmode')??'prefer'},stdio:['ignore','pipe','pipe']});const done=new Promise<number|null>((r,j)=>{child.once('error',j);child.once('exit',r);});child.stderr.on('data',()=>{});await pipeline(child.stdout,createWriteStream(raw,{mode:0o600}));if(await done!==0)throw new Error('PG_DUMP_FAILED');await encryptBackup(raw,dest,process.env.BACKUP_ENCRYPTION_KEY);await writeFile(dest+'.manifest.json',JSON.stringify({created_at:new Date().toISOString(),status:'PASS',scope:local?'local-backup':'operator-authorized-production-backup',restore_verified:false,rpo:'Snapshot only; not PITR.'}),{mode:0o600});metric('backup_last_success_seconds',Date.now()/1000);console.log(JSON.stringify({status:'PASS',encrypted:true,restore_verified:false}));
}catch{metric('backup_failures_total',1);console.log(JSON.stringify({status:'FAIL',reason:'BACKUP_FAILED; no credentials emitted'}));process.exitCode=1;}finally{await rm(temp,{recursive:true,force:true});await shutdownTelemetry();}
