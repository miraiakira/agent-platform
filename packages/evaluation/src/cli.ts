import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {randomUUID} from 'node:crypto';
import {parseDataset,runConfigSchema,type EvaluationReport} from './schema';
import {BaselineComparator,EvaluationReporter,qualityGate} from './comparison';
import {EvaluationStore} from './store';
import {runEvaluationWorker} from './worker';
const {positionals,values}=parseArgs({allowPositionals:true,options:{dataset:{type:'string'},'dataset-id':{type:'string'},provider:{type:'string',default:'mock'},baseline:{type:'string'},'baseline-run':{type:'string'},current:{type:'string'},out:{type:'string',default:'artifacts/evaluation'},ci:{type:'boolean',default:false},'gate-config':{type:'string'}}});
const reporter=new EvaluationReporter();
const inputPath=(path:string)=>resolve(process.env.INIT_CWD??process.cwd(),path);
async function artifact(report:EvaluationReport,baseline?:EvaluationReport){const gate=qualityGate(report,values['gate-config']?JSON.parse(await readFile(inputPath(values['gate-config']),'utf8')):{},baseline);const directory=inputPath(values.out!);await mkdir(directory,{recursive:true});await writeFile(resolve(directory,'report.json'),reporter.json(report));await writeFile(resolve(directory,'summary.md'),reporter.markdown(report,gate));await writeFile(resolve(directory,'gate.json'),JSON.stringify(gate,null,2));console.log(JSON.stringify({status:gate.passed?'passed':'failed',cases:report.summary.total,score:report.summary.overall_score,reasons:gate.reasons,output:directory}));process.exitCode=gate.exit_code;}
async function main(){const command=positionals[0]??'run';const baseline=values.baseline?JSON.parse(await readFile(inputPath(values.baseline),'utf8')) as EvaluationReport:undefined;
 if(command==='compare'){if(!values.current||!baseline)throw new Error('CURRENT_AND_BASELINE_REQUIRED');const report=JSON.parse(await readFile(inputPath(values.current),'utf8')) as EvaluationReport;new BaselineComparator().compare(report,baseline);return artifact(report,baseline);}
 if(command==='report'){if(!values.current)throw new Error('CURRENT_REPORT_REQUIRED');return artifact(JSON.parse(await readFile(inputPath(values.current),'utf8')),baseline);}
 if(command!=='run')throw new Error('UNKNOWN_COMMAND');
 const document=values.dataset?parseDataset(await readFile(inputPath(values.dataset),'utf8')):undefined;
 if(values.ci){if(values['baseline-run'])throw new Error('CI_BASELINE_REPORT_ONLY');if(!document)throw new Error('DATASET_PATH_REQUIRED');if(values.provider!=='mock')throw new Error('CI_MOCK_ONLY');if(!process.env.TEST_DATABASE_URL)throw new Error('TEST_DATABASE_URL_REQUIRED');
  const {securityDatabase}=await import('../../persistence/tests/security-database');const {SecurityStore,withSecurityContext}=await import('@eap/persistence');const db=await securityDatabase();const abort=new AbortController();let worker:Promise<void>|undefined;
  try{const actor=`eval-ci-${randomUUID()}`;await db.auth.query('INSERT INTO "user"(id,name,email) VALUES($1,$1,$2)',[actor,`${actor}@example.test`]);const security=new SecurityStore(db.app);const tenant=await withSecurityContext({actorUserId:actor},()=>security.createTenant('Evaluation CI'));const scope=<T>(fn:()=>T)=>withSecurityContext({tenantId:tenant.id,actorUserId:actor},fn);const store=new EvaluationStore(db.app);const published=await scope(()=>store.publish(document));const run=await scope(async()=>store.submit(published.version_id,{code_revision:process.env.GITHUB_SHA??'working-tree'},undefined,values['gate-config']?JSON.parse(await readFile(inputPath(values['gate-config']),'utf8')):{}));worker=runEvaluationWorker({db:db.worker,workerId:'evaluation-ci',signal:abort.signal,pollMs:10});
   const deadline=Date.now()+30000;while(true){const result=await scope(()=>store.run(run.id));if(result.status==='completed'){await artifact(result.report,baseline);break;}if(['failed','cancelled','interrupted'].includes(result.status))throw new Error(result.error_code??'EVALUATION_FAILED');if(Date.now()>deadline)throw new Error('EVALUATION_TIMEOUT');await new Promise(r=>setTimeout(r,50));}
  }finally{abort.abort();await worker;await db.close();}return;
 }
 const cookie=process.env.EVAL_SESSION_COOKIE,tenant=process.env.EVAL_TENANT_ID;if(!cookie||!tenant)throw new Error('EVAL_SESSION_COOKIE_AND_TENANT_REQUIRED');
 const base=process.env.EVAL_API_URL??process.env.BETTER_AUTH_URL??'http://localhost:3551';const origin=new URL(base).origin;
 const request=async(path:string,body?:unknown)=>{const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,'x-tenant-id':tenant,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error(`EVALUATION_API_${response.status}`);return response.json();};
 let versionId=values['dataset-id'];if(versionId&&!document)versionId=(await request(`/api/evaluations/datasets/${encodeURIComponent(versionId)}`)).dataset.id;if(document)versionId=(await request('/api/evaluations/datasets',{dataset:document})).version_id;if(!versionId)throw new Error('DATASET_PATH_OR_ID_REQUIRED');
 const config=runConfigSchema.parse({provider:values.provider,model:values.provider==='mock'?'mock-model':process.env.LLM_MODEL??'deepseek-flash'});
 const run=await request('/api/evaluations/runs',{dataset_version_id:versionId,baseline_run_id:values['baseline-run'],config,gate:values['gate-config']?JSON.parse(await readFile(inputPath(values['gate-config']),'utf8')):undefined});const deadline=Date.now()+310000;
 while(true){const {run:result}=await request(`/api/evaluations/runs/${run.id}`);if(result.status==='completed'){const previous=values['baseline-run']?(await request(`/api/evaluations/runs/${encodeURIComponent(values['baseline-run'])}`)).run.report:baseline;return artifact(result.report,previous);}if(['failed','cancelled','interrupted'].includes(result.status))throw new Error('EVALUATION_FAILED');if(Date.now()>deadline)throw new Error('EVALUATION_TIMEOUT');await new Promise(r=>setTimeout(r,1000));}
}
main().catch(error=>{console.error(JSON.stringify({error:error instanceof Error&&/^[A-Z_0-9]+$/.test(error.message)?error.message:'EVALUATION_COMMAND_FAILED'}));process.exitCode=2;});
