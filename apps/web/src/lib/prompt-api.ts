import {z} from 'zod';
import {SecurityError,securityContext,type Permission} from '@eap/persistence';
import {PromptOpsStore,EvaluationStore,runConfigSchema} from '@eap/evaluation';
import {protectedApi} from './security';
import {pool,security} from './persistence';
import {evaluationBody} from './evaluation-api';
const uuid=z.uuid();
export function promptApi(request:Request,permission:Permission,fn:(store:PromptOpsStore)=>Promise<Response>){return protectedApi(request,permission,async()=>{
 try{if(request.method!=='GET')await security.limit(`prompt-write:${securityContext()?.tenantId}`,30,60);return await fn(new PromptOpsStore(pool));}
 catch(error){if(error instanceof z.ZodError)return Response.json({error:'INVALID_PROMPT_SCHEMA'},{status:400});throw error;}
});}
export async function promptOperation(r:Request,params:Promise<{id:string;operation?:string[]}>){
 const {id,operation=[]}=await params;
 const permission:Permission=r.method==='GET'?'prompt:read':operation[0]==='versions'&&operation[2]!=='evaluate'?'prompt:edit':operation[2]==='evaluate'?'evaluation:run':'prompt:release';
 return promptApi(r,permission,async store=>{
  uuid.parse(id);const [group,resource,action]=operation;
  if(operation.length>3)throw new SecurityError(404,'NOT_FOUND');
  if(r.method==='GET'){
   if(!group)return Response.json({prompt:await store.detail(id)});
   if(group==='experiments'&&resource&&action==='results')return Response.json(await store.results(id,uuid.parse(resource)));
   if(group==='releases'||group==='experiments'){const d=await store.detail(id);return Response.json({[group]:d[group]});}
   throw new SecurityError(404,'NOT_FOUND');
  }
  const body=await evaluationBody(r);
  if(group==='versions'){
   if(!resource)return Response.json({version:await store.draft(id,body)},{status:201});uuid.parse(resource);
   if(action==='archive'){const b=z.object({revision:z.number().int().positive()}).strict().parse(body);return Response.json({version:await store.archive(id,resource,b.revision)});}
   if(action==='publish'){const b=z.object({revision:z.number().int().positive()}).strict().parse(body);return Response.json({version:await store.publish(id,resource,b.revision)});}
   if(action==='evaluate'){
    const b=z.object({dataset_version_id:uuid,baseline_run_id:uuid.optional(),config:runConfigSchema.optional()}).strict().parse(body);
    const d=await store.detail(id),version=d.versions.find((v:{id:string;model_config:{provider:"mock"|"deepseek";model:string}})=>v.id===resource);if(!version)throw new SecurityError(404,'NOT_FOUND');
    const config={...b.config,provider:version.model_config.provider,model:version.model_config.model,prompt_version_id:resource,code_revision:process.env.EVAL_CODE_REVISION??process.env.GITHUB_SHA??'working-tree'};
    await security.limit(`eval-submit:${securityContext()?.tenantId}`,10,60);
    return Response.json(await new EvaluationStore(pool).submit(b.dataset_version_id,config,b.baseline_run_id),{status:202});
   }
   if(!action)return Response.json({version:await store.draft(id,body,resource)});
  }
  if(group==='releases'){
   if(!resource)return Response.json({release:await store.release(id,body)},{status:201});uuid.parse(resource);
   if(['rollout','rollback','change'].includes(action??'')){
    const b=z.object({revision:z.number().int().positive(),action:z.string().optional(),percentage:z.number().optional(),reason:z.string().optional()}).strict().parse(body);
    return Response.json({release:await store.changeRelease(id,resource,{...b,action:action==='rollback'?'rollback':b.action??'rollout'})});
   }
  }
  if(group==='experiments'){
   if(!resource)return Response.json({experiment:await store.experiment(id,body)},{status:201});
   if(!action)return Response.json({experiment:await store.changeExperiment(id,uuid.parse(resource),body)});
  }
  if(group==='revoke'&&!resource)return Response.json(await store.revoke(id,body));
  throw new SecurityError(404,'NOT_FOUND');
 });
}
