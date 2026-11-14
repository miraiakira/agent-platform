import {createHash} from 'node:crypto';
import {boundedInteger} from './limits';
export type Verification='VERIFIED'|'NOT VERIFIED'|'FAILED'|'NOT APPLICABLE';
export interface ReadinessCheck {id:string;grade:'PASS'|'WARN'|'FAIL';verification:Verification;critical:boolean;reason:string}
export function configurationChecks(env:NodeJS.ProcessEnv):ReadinessCheck[]{
 const checks:ReadinessCheck[]=[];
 const add=(id:string,ok:boolean,reason:string,critical=true)=>checks.push({id,grade:ok?'PASS':'FAIL',verification:ok?'VERIFIED':'FAILED',critical,reason});
 const secret=(name:string,hex=false)=>{const v=env[name]??'';add(name,v.length>=32&&new Set(v).size>=10&&!/test|example|replace|development|dev[_-]|ci-only/i.test(v)&&(!hex||/^[a-f0-9]{64}$/i.test(v)),'Secret configured with required shape; value redacted.');};
 add('NODE_ENV',env.NODE_ENV==='production','Production configuration is required for a production gate.');
 try{const u=new URL(env.DATABASE_URL??'');add('DATABASE_URL',/^postgres(?:ql)?:$/.test(u.protocol)&&!!u.username&&!!u.password,'Runtime URL shape checked; credentials redacted.');add('DATABASE_TLS',u.searchParams.get('sslmode')==='verify-full','Require verify-full and deployment CA trust.');}catch{add('DATABASE_URL',false,'Missing or malformed runtime URL.');}
 for(const key of ['BETTER_AUTH_SECRET','BUSINESS_API_KEY','PROMPT_ROUTING_KEY'])secret(key);secret('AGENT_CHECKPOINT_KEY',true);
 try{const u=new URL(env.BETTER_AUTH_URL??'');add('AUTH_ORIGIN',u.protocol==='https:'&&!u.username&&!u.password&&u.pathname==='/'&&!u.search,'Auth must use one explicit HTTPS origin; cookie/CSRF behavior also needs deployed evidence.');}catch{add('AUTH_ORIGIN',false,'HTTPS Auth origin required.');}
 add('TRUSTED_PROXY',env.TRUST_PROXY==='false','This app ignores forwarded client IP headers; proxy trust must stay disabled until separately implemented.');
 add('FAULT_INJECTION_DISABLED',env.ENABLE_FAULT_INJECTION!=='true','Fault fixtures are CLI/test-only; production fault switches are forbidden.');
 add('PROVIDER',env.LLM_PROVIDER==='deepseek'||env.LLM_PROVIDER==='mock'&&env.APPROVE_PRODUCTION_MOCK==='true','Mock requires explicit production approval.');
 if(env.LLM_PROVIDER==='deepseek')secret('LLM_API_KEY');
 add('EMBEDDING_PROVIDER',(env.EMBEDDING_PROVIDER??'mock')!=='mock'||env.APPROVE_PRODUCTION_MOCK==='true','Mock embedding requires explicit production approval.');
 if(env.EMBEDDING_PROVIDER&&env.EMBEDDING_PROVIDER!=='mock')secret('EMBEDDING_API_KEY');
 const limits:Record<string,[number,number]>={PG_POOL_MAX:[1,32],PG_STATEMENT_TIMEOUT_MS:[100,60000],WORKER_CONCURRENCY:[1,8],WORKER_SHUTDOWN_GRACE_MS:[1000,60000],WORKER_MAX_DURATION_MS:[1000,300000],AGENT_GLOBAL_ADMISSION_LIMIT:[1,4096],AGENT_TENANT_ADMISSION_LIMIT:[1,64],AGENT_TENANT_QUEUE_LIMIT:[1,256]};
 for(const [key,[min,max]] of Object.entries(limits)){const n=Number(env[key]);add(key,env[key]!==undefined&&Number.isInteger(n)&&n>=min&&n<=max,`Explicit bounded configuration required (${min}..${max}).`);}
 add('OBSERVABILITY',env.OTEL_ENABLED==='true'&&!!env.OTEL_EXPORTER_OTLP_ENDPOINT,'Exporter configuration is present; actual collection requires separate evidence.');
 add('BACKUP_CONFIGURATION',!!env.BACKUP_DIRECTORY&&!!env.BACKUP_RETENTION_DAYS&&Number(env.BACKUP_RETENTION_DAYS)>0&&/^[a-f0-9]{64}$/i.test(env.BACKUP_ENCRYPTION_KEY??''),'Encrypted backup location, retention and independent key required.');
 add('CODE_REVISION',!!env.EVAL_CODE_REVISION&&!['working-tree','unknown'].includes(env.EVAL_CODE_REVISION),'Use an immutable deployment revision.');
 return checks;
}
export const proposedSlos={
 api_availability:{target:0.999,window:'30d',numerator:'eligible requests without service failures',denominator:'eligible authenticated and valid requests',exclusions:'invalid input, denied authorization; capacity rejections are reported separately and in submission availability',source:'HTTP metrics and load samples',alert:'14.4x 5m/1h or 6x 30m/6h'},
 job_submission:{target:0.999,window:'30d',numerator:'202 accepted submissions',denominator:'valid authorized submission attempts including capacity rejections',exclusions:'client invalid requests; idempotent HTTP retries count as requests, unique jobs reported separately',source:'HTTP submissions + persisted request keys',alert:'14.4x 5m/1h'},
 job_completion:{target:0.99,window:'30d',numerator:'accepted noncancelled jobs completed within active deadline',denominator:'eligible terminal jobs plus overdue nonterminal jobs',exclusions:'user cancellation and human approval waiting time; report pending populations separately',source:'agent_runs/agent_jobs/agent_approvals and execution traces',alert:'6x 30m/6h'},
 api_latency:{target:0.95,threshold_ms:300,window:'30d',numerator:'eligible lightweight nonstreaming requests <=300ms',denominator:'all eligible lightweight requests',exclusions:'SSE, LLM inference, upload and long tasks',source:'HTTP endpoint-labelled duration histogram',alert:'burn or p95 sustained 15m'},
 retrieval:{target:0.95,threshold_ms:500,window:'30d',numerator:'eligible retrievals <=500ms',denominator:'all eligible retrievals',exclusions:'external LLM; baseline applies only to recorded corpus size/hardware',source:'knowledge_retrieval_duration_seconds',alert:'burn or p95 sustained 15m'}
};
export function errorBudget(good:number,total:number,target:number){
 if(!Number.isInteger(total)||!Number.isInteger(good)||good<0||total<good||target<=0||target>=1)throw new Error('INVALID_SLI');
 if(!total)return {verification:'NOT VERIFIED' as const,availability:null,burn_rate:null,remaining_fraction:null};
 const bad=total-good,budget=total*(1-target);
 return {verification:'VERIFIED' as const,availability:good/total,burn_rate:bad/budget,remaining_fraction:(budget-bad)/budget};
}
export function burnAlert(short:{good:number;total:number},long:{good:number;total:number},target:number,threshold:number){const a=errorBudget(short.good,short.total,target),b=errorBudget(long.good,long.total,target);return a.burn_rate===null||b.burn_rate===null?null:a.burn_rate>=threshold&&b.burn_rate>=threshold;}
export function readinessPassed(checks:ReadinessCheck[]){return checks.length>0&&checks.every(c=>c.grade!=='FAIL'&&(!c.critical||['VERIFIED','NOT APPLICABLE'].includes(c.verification)));}
export function assertFaultSafety(){if(process.env.NODE_ENV==='production'&&process.env.ENABLE_FAULT_INJECTION==='true')throw new Error('PRODUCTION_FAULT_INJECTION_FORBIDDEN');}
export function workerCapacity(){return boundedInteger('WORKER_CONCURRENCY',1,1,8);}

export function configurationFingerprint(env:NodeJS.ProcessEnv){const keys=['NODE_ENV','DATABASE_URL','READINESS_DATABASE_URL','BETTER_AUTH_URL','BETTER_AUTH_SECRET','BUSINESS_API_KEY','AGENT_CHECKPOINT_KEY','PROMPT_ROUTING_KEY','TRUST_PROXY','LLM_PROVIDER','LLM_MODEL','LLM_API_KEY','EMBEDDING_PROVIDER','EMBEDDING_API_KEY','APPROVE_PRODUCTION_MOCK','ENABLE_FAULT_INJECTION','PG_POOL_MAX','PG_STATEMENT_TIMEOUT_MS','AGENT_GLOBAL_ADMISSION_LIMIT','AGENT_TENANT_ADMISSION_LIMIT','AGENT_TENANT_QUEUE_LIMIT','WORKER_CONCURRENCY','WORKER_SHUTDOWN_GRACE_MS','WORKER_MAX_DURATION_MS','OTEL_ENABLED','OTEL_EXPORTER_OTLP_ENDPOINT','BACKUP_DIRECTORY','BACKUP_RETENTION_DAYS','BACKUP_ENCRYPTION_KEY','EVAL_CODE_REVISION'];return createHash('sha256').update(JSON.stringify(keys.map(k=>[k,env[k]??null]))).digest('hex');}

export function assertWorkerProductionSafety(){
 assertFaultSafety();if(process.env.NODE_ENV!=='production')return;
 if((process.env.LLM_PROVIDER??'mock')==='mock'&&process.env.APPROVE_PRODUCTION_MOCK!=='true')throw new Error('PRODUCTION_MOCK_PROVIDER_REQUIRES_APPROVAL');
 if((process.env.EMBEDDING_PROVIDER??'mock')==='mock'&&process.env.APPROVE_PRODUCTION_MOCK!=='true')throw new Error('PRODUCTION_MOCK_EMBEDDING_REQUIRES_APPROVAL');
}
