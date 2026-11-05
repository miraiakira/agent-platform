import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {promptHash,renderPrompt,trustedPromptVariables,validatePromptDocument,SecurityStore,securityContext,withSecurityContext,withTenantTransaction} from '@eap/persistence';
import {inSpan,metric,log} from '@eap/observability';
import {EvaluationRunner,DeterministicProvider} from './runner';
import {createModelProvider} from '@eap/ai';
import {ScorerRegistry} from './scorers';
import {ModelBasedScorer} from './judge';
import {canonical,contentHash,parseDataset,runConfigSchema,type EvaluationReport} from './schema';
import {qualityGate,verifyReport} from './comparison';
export async function runEvaluationWorker(options:{db:Pool;workerId:string;signal:AbortSignal;pollMs?:number;clock?:import("./runner").Clock}){
 const {db,workerId,signal}=options;const security=new SecurityStore(db);
 while(!signal.aborted){
  try{
   const row=(await db.query('SELECT * FROM eap_claim_eval($1,$2,$3)',[workerId,randomUUID(),15])).rows[0];if(!row){await delay(options.pollMs??1000,undefined,{signal}).catch(()=>{});continue;}
   await withSecurityContext({tenantId:row.tenant_id,actorUserId:row.created_by},async()=>{
    const local=new AbortController(),stop=new AbortController();let heartbeatError=false;
    const heartbeat=(async()=>{while(!stop.signal.aborted){try{await delay(500,undefined,{signal:stop.signal});}catch{break;}try{await security.authorize('evaluation:run');const result=await db.query("UPDATE eval_runs SET lease_expires_at=clock_timestamp()+interval '15 seconds' WHERE id=$1 AND status='running' AND lease_token=$2 AND lease_expires_at>clock_timestamp() AND cancel_requested_at IS NULL RETURNING id",[row.id,row.lease_token]);if(!result.rowCount)local.abort();}catch{heartbeatError=true;local.abort();}}})();
    let report:EvaluationReport|undefined,gate:ReturnType<typeof qualityGate>|undefined,error:string|undefined;
    try{
     await security.authorize('evaluation:run');const config=runConfigSchema.parse(row.config_snapshot);const external=process.env.EVAL_ALLOW_EXTERNAL==='true';if(config.provider!=='mock'&&!external)throw new Error('EXTERNAL_PROVIDER_DISABLED');if(config.judge_enabled&&(!external||process.env.EVAL_ALLOW_JUDGE!=='true'))throw new Error('JUDGE_DISABLED');
     const version=(await db.query('SELECT document,content_hash FROM eval_dataset_versions WHERE id=$1 AND published_at IS NOT NULL',[row.dataset_version_id])).rows[0];const dataset=parseDataset(version?.document);if(contentHash(dataset)!==version.content_hash)throw new Error('DATASET_HASH_MISMATCH');
     const scorers=new ScorerRegistry();if(config.judge_enabled){if(!process.env.EVAL_JUDGE_API_KEY||!process.env.EVAL_JUDGE_MODEL)throw new Error('JUDGE_NOT_CONFIGURED');scorers.register('model_based',new ModelBasedScorer({provider:createModelProvider({provider:'deepseek',apiKey:process.env.EVAL_JUDGE_API_KEY,model:process.env.EVAL_JUDGE_MODEL}),model:process.env.EVAL_JUDGE_MODEL,allowExternal:true,timeoutMs:5000,retries:1}));}
     let promptSystem:string|undefined;
     if(row.prompt_version_id){const v=(await db.query("SELECT * FROM prompt_versions WHERE id=$1 AND status='published'",[row.prompt_version_id])).rows[0];if(!v||v.content_hash!==row.prompt_content_hash||promptHash(v.document)!==row.prompt_content_hash||config.prompt_content_hash!==row.prompt_content_hash||config.prompt_version_id!==row.prompt_version_id||promptHash(row.tool_policy_document)!==config.tool_policy_hash)throw new Error('PROMPT_HASH_MISMATCH');if((await db.query('SELECT 1 FROM prompt_revocations WHERE version_id=$1',[v.id])).rowCount)throw new Error('PROMPT_REVOKED');const d=validatePromptDocument(v.document);promptSystem=renderPrompt(d,trustedPromptVariables(d));}
     const runner=new EvaluationRunner({clock:options.clock,promptSystem,scorers,allowExternal:external,providerFactory:(c,configuration)=>configuration.provider==='mock'?new DeterministicProvider(c):createModelProvider({provider:'deepseek',apiKey:process.env.LLM_API_KEY,model:configuration.model,baseURL:process.env.LLM_BASE_URL||undefined})});
     const caseRows=(await db.query('SELECT id,case_id FROM eval_cases WHERE dataset_version_id=$1',[row.dataset_version_id])).rows;
     report=await inSpan('agent.evaluation.run',{'agent.run_id':row.id},()=>runner.run(dataset,config,AbortSignal.any([signal,local.signal]),async result=>{
      await withTenantTransaction(db,securityContext()!,async client=>{
       if(!(await client.query("SELECT id FROM eval_runs WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_expires_at>clock_timestamp() FOR UPDATE",[row.id,row.lease_token])).rowCount)throw new Error('LEASE_LOST');
       const caseRow=caseRows.find(c=>c.case_id===result.case_id);if(!caseRow)throw new Error('CASE_MANIFEST_MISMATCH');
       await client.query('INSERT INTO eval_case_results(id,tenant_id,eval_run_id,dataset_version_id,eval_case_id,status,score,document,canonical_document,content_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)',[randomUUID(),row.tenant_id,row.id,row.dataset_version_id,caseRow.id,result.status,result.score,JSON.stringify(result),canonical(result),contentHash(result)]);
      });
     }));
     const baseline=row.baseline_run_id?(await db.query('SELECT report FROM eval_runs WHERE id=$1 AND status=\'completed\'',[row.baseline_run_id])).rows[0]?.report:undefined;if(row.baseline_run_id&&!baseline)throw new Error('BASELINE_UNAVAILABLE');gate=qualityGate(report,row.gate_config,baseline);
    }catch(e){error=e&&typeof e==='object'&&'code' in e?String(e.code):e instanceof Error&&/^[A-Z_]+$/.test(e.message)?e.message:'EVAL_EXECUTION_ERROR';}
    finally{stop.abort();await heartbeat;}
    await withTenantTransaction(db,securityContext()!,async client=>{
     const current=(await client.query("SELECT * FROM eval_runs WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_expires_at>clock_timestamp() FOR UPDATE",[row.id,row.lease_token])).rows[0];if(!current)return;
     const cancelled=!!current.cancel_requested_at;const status=cancelled?'cancelled':signal.aborted||heartbeatError?'interrupted':error?'failed':'completed';if(status!=='completed'&&gate)gate={...gate,passed:false,exit_code:1,reasons:[...gate.reasons,status==='cancelled'?'CANCELLED':'EXECUTION_INCOMPLETE']};
     if(report){verifyReport(report);const cases=(await client.query('SELECT id,case_id FROM eval_cases WHERE dataset_version_id=$1',[row.dataset_version_id])).rows;
      for(const result of report.results){const existing=(await client.query("SELECT content_hash FROM eval_case_results WHERE eval_run_id=$1 AND document->>'case_id'=$2",[row.id,result.case_id])).rows[0];if(existing){if(existing.content_hash!==contentHash(result))throw new Error('RESULT_HASH_MISMATCH');continue;}const caseRow=cases.find(c=>c.case_id===result.case_id);if(!caseRow)throw new Error('CASE_MANIFEST_MISMATCH');await client.query('INSERT INTO eval_case_results(id,tenant_id,eval_run_id,dataset_version_id,eval_case_id,status,score,document,canonical_document,content_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)',[randomUUID(),row.tenant_id,row.id,row.dataset_version_id,caseRow.id,result.status,result.score,JSON.stringify(result),canonical(result),contentHash(result)]);}
     }
     await security.audit('evaluation.run.complete','eval_run',row.id,status==='completed'&&gate?.passed?'allow':'deny',error??(gate?.passed?'PASSED':'GATE_FAILED'),client);
     await client.query('UPDATE eval_runs SET status=$3,completed_at=clock_timestamp(),lease_expires_at=NULL,error_code=$4,report=$5::jsonb,canonical_report=$6,report_hash=$7,gate_result=$8::jsonb WHERE id=$1 AND lease_token=$2',[row.id,row.lease_token,status,cancelled?'CANCELLED':signal.aborted?'WORKER_STOPPED':error??null,report?JSON.stringify(report):null,report?canonical(report):null,report?contentHash(report):null,gate?JSON.stringify(gate):null]);
    });
    if(gate&&!gate.passed)metric('agent_eval_gate_failures_total',1);if(gate?.comparison?.regression_cases.length)metric('agent_eval_regressions_total',gate.comparison.regression_cases.length);
   });
  }catch{log('error','evaluation.worker_error',{error_code:'EVAL_WORKER_ERROR'});await delay(options.pollMs??1000,undefined,{signal}).catch(()=>{});}
 }
}
