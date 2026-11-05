import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {promptHash,promptPolicies,validatePromptDocument,SecurityStore,SecurityError,securityContext,withTenantTransaction} from '@eap/persistence';
import {parseDataset,canonical,contentHash,runConfigSchema,type EvaluationReport,type EvaluationResult,type EvaluationDataset} from './schema';
import {gateSchema} from './comparison';
export class EvaluationStore {
 readonly security:SecurityStore;
 constructor(readonly db:Pool){this.security=new SecurityStore(db);}
 async datasets(){await this.security.authorize('evaluation:read');return (await this.db.query('SELECT d.*,v.id AS version_id,v.version,v.content_hash,v.published_at FROM eval_datasets d JOIN eval_dataset_versions v ON v.dataset_id=d.id ORDER BY d.created_at DESC,v.version DESC LIMIT 200')).rows;}
 async dataset(id:string){await this.security.authorize('evaluation:read');const rows=(await this.db.query('SELECT * FROM eval_dataset_versions WHERE id=$1 OR dataset_id=$1 ORDER BY version DESC LIMIT 1',[id])).rows;const row=rows[0];if(!row)throw new SecurityError(404,'NOT_FOUND');const document=parseDataset(row.document);if(contentHash(document)!==row.content_hash)throw new SecurityError(409,'DATASET_HASH_MISMATCH');return {...row,document};}
 async publish(input:unknown,datasetId?:string){const document=parseDataset(input);await this.security.authorize('evaluation:manage');return withTenantTransaction(this.db,securityContext()!,async c=>{
  await this.security.authorize('evaluation:manage',c);const ctx=securityContext()!;const id=datasetId??randomUUID();
  if(datasetId){await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${ctx.tenantId}:${id}`]);if(!(await c.query('SELECT id FROM eval_datasets WHERE id=$1',[id])).rowCount)throw new SecurityError(404,'NOT_FOUND');}
  else await c.query('INSERT INTO eval_datasets(id,tenant_id,name,description,created_by) VALUES($1,$2,$3,$4,$5)',[id,ctx.tenantId,document.name,document.description,ctx.actorUserId]);
  const versionId=randomUUID();await c.query('INSERT INTO eval_dataset_versions(id,tenant_id,dataset_id,version,content_hash,document,canonical_document) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)',[versionId,ctx.tenantId,id,document.version,contentHash(document),JSON.stringify(document),canonical(document)]);
  for(const [ordinal,value] of document.cases.entries())await c.query('INSERT INTO eval_cases(id,tenant_id,dataset_version_id,case_id,ordinal,document,content_hash,canonical_document) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)',[randomUUID(),ctx.tenantId,versionId,value.case_id,ordinal,JSON.stringify(value),contentHash(value),canonical(value)]);
  await c.query('UPDATE eval_dataset_versions SET published_at=clock_timestamp() WHERE id=$1',[versionId]);await this.security.audit('evaluation.dataset.publish','eval_dataset_version',versionId,'allow','PUBLISHED',c);return {id,version_id:versionId,version:document.version,content_hash:contentHash(document)};
 });}
 async submit(versionId:string,configInput:unknown={},baselineId?:string,gateInput:unknown={}){const config=runConfigSchema.parse(configInput),gate=gateSchema.parse(gateInput);await this.security.authorize('evaluation:run');
  // API/queued evaluations deliberately permit only sandboxed deterministic mode.
  if(config.provider!=='mock'&&process.env.EVAL_ALLOW_EXTERNAL!=='true')throw new SecurityError(400,'EXTERNAL_PROVIDER_DISABLED');if(config.judge_enabled&&(process.env.EVAL_ALLOW_EXTERNAL!=='true'||process.env.EVAL_ALLOW_JUDGE!=='true'))throw new SecurityError(400,'JUDGE_DISABLED');
  return withTenantTransaction(this.db,securityContext()!,async c=>{const ctx=securityContext()!;await c.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[ctx.tenantId]);await this.security.authorize('evaluation:run',c);
   const version=(await c.query('SELECT * FROM eval_dataset_versions WHERE id=$1 AND published_at IS NOT NULL',[versionId])).rows[0];if(!version)throw new SecurityError(404,'NOT_FOUND');
   let policies:unknown=null;
   if(config.prompt_version_id){
    const prompt=(await c.query("SELECT * FROM prompt_versions WHERE id=$1 AND status='published'",[config.prompt_version_id])).rows[0];
    if(!prompt)throw new SecurityError(404,'NOT_FOUND');validatePromptDocument(prompt.document);
    if(promptHash(prompt.document)!==prompt.content_hash||(await c.query('SELECT 1 FROM prompt_revocations WHERE version_id=$1',[prompt.id])).rowCount)throw new SecurityError(409,'PROMPT_UNAVAILABLE');
    if(config.provider!==prompt.model_config.provider||config.model!==prompt.model_config.model)throw new SecurityError(409,'PROMPT_MODEL_MISMATCH');
    policies=await promptPolicies(c);config.prompt_content_hash=prompt.content_hash;config.tool_policy_hash=promptHash(policies);config.prompt_version=prompt.id;
   }else if(config.prompt_content_hash||config.tool_policy_hash)throw new SecurityError(400,'PROMPT_VERSION_REQUIRED');
   if(baselineId){const baseline=(await c.query('SELECT dataset_version_id,status FROM eval_runs WHERE id=$1',[baselineId])).rows[0];if(!baseline||baseline.status!=='completed')throw new SecurityError(404,'BASELINE_UNAVAILABLE');if(baseline.dataset_version_id!==versionId)throw new SecurityError(409,'INCOMPATIBLE_DATASET_VERSION');}
   if(Number((await c.query("SELECT count(*) FROM eval_runs WHERE status IN ('queued','running')")).rows[0].count)>=2)throw new SecurityError(429,'EVAL_CONCURRENCY_LIMIT');
   const id=randomUUID();await c.query(`INSERT INTO eval_runs(id,tenant_id,dataset_version_id,baseline_run_id,model_provider,model_name,model_version,prompt_version,code_revision,config_snapshot,gate_config,created_by,prompt_version_id,prompt_content_hash,tool_policy_document) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15::jsonb)`,[id,ctx.tenantId,versionId,baselineId??null,config.provider,config.model,config.model_version,config.prompt_version,config.code_revision,JSON.stringify(config),JSON.stringify(gate),ctx.actorUserId,config.prompt_version_id??null,config.prompt_content_hash??null,JSON.stringify(policies)]);await this.security.audit('evaluation.run.create','eval_run',id,'allow','QUEUED',c);return {id,status:'queued'};
  });
 }
 async runs(){await this.security.authorize('evaluation:read');return (await this.db.query('SELECT id,dataset_version_id,baseline_run_id,status,model_provider,model_name,created_at,completed_at,error_code,report->\'summary\' AS summary,gate_result FROM eval_runs ORDER BY created_at DESC LIMIT 100')).rows;}
 async run(id:string){await this.security.authorize('evaluation:read');const row=(await this.db.query('SELECT id,tenant_id,dataset_version_id,baseline_run_id,status,created_by,model_provider,model_name,model_version,prompt_version,code_revision,config_snapshot,created_at,completed_at,error_code,report,gate_result FROM eval_runs WHERE id=$1',[id])).rows[0];if(!row)throw new SecurityError(404,'NOT_FOUND');return row;}
 async results(id:string){await this.run(id);return (await this.db.query('SELECT document,content_hash FROM eval_case_results WHERE eval_run_id=$1 ORDER BY created_at,id',[id])).rows;}
 async cancel(id:string){await this.security.authorize('evaluation:run');if(!(await this.db.query("UPDATE eval_runs SET cancel_requested_at=clock_timestamp() WHERE id=$1 AND status IN ('queued','running') RETURNING id",[id])).rowCount)throw new SecurityError(409,'EVAL_NOT_ACTIVE');await this.security.audit('evaluation.run.cancel','eval_run',id,'allow','REQUESTED');}
}
