import {z} from 'zod';
import {SecurityError,type Permission} from '@eap/persistence';
import {EvaluationStore,runConfigSchema,gateSchema,BaselineComparator,MAX_DATASET_BYTES} from '@eap/evaluation';
import {protectedApi} from './security';
import {pool} from './persistence';
export function evaluationStore(){return new EvaluationStore(pool);}
export const idSchema=z.uuid();
export async function evaluationBody(request:Request){if(Number(request.headers.get('content-length')??0)>MAX_DATASET_BYTES)throw new SecurityError(413,'DATASET_TOO_LARGE');
 const reader=request.body?.getReader();if(!reader)throw new SecurityError(400,'INVALID_JSON');let size=0;const chunks:Uint8Array[]=[];try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_DATASET_BYTES){await reader.cancel();throw new SecurityError(413,'DATASET_TOO_LARGE');}chunks.push(value);}}finally{reader.releaseLock();}
 return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
export function evaluationApi(request:Request,permission:Permission,fn:()=>Promise<Response>){return protectedApi(request,permission,async()=>{try{return await fn();}catch(error){if(error instanceof Error&&error.message==='DATASET_TOO_LARGE')throw new SecurityError(413,'DATASET_TOO_LARGE');if(error&&typeof error==='object'&&'code' in error&&error.code==='23505')throw new SecurityError(409,'DATASET_VERSION_CONFLICT');if(error instanceof Error&&['INVALID_DATASET','DATASET_COMPLEXITY_LIMIT'].includes(error.message))throw new SecurityError(400,error.message);if(error instanceof z.ZodError)return Response.json({error:'INVALID_EVALUATION_SCHEMA'},{status:400});throw error;}});}
export const runInputSchema=z.object({dataset_version_id:z.uuid(),baseline_run_id:z.uuid().optional(),config:runConfigSchema.optional(),gate:gateSchema.optional()}).strict();
export async function evaluationId(params:Promise<{id:string}>){const {id}=await params;if(!idSchema.safeParse(id).success)throw new SecurityError(400,'INVALID_ID');return id;}
export async function compareRun(id:string,baselineId?:string){const current=await evaluationStore().run(id);const baseline=baselineId??current.baseline_run_id;if(!baseline||!idSchema.safeParse(baseline).success)throw new SecurityError(400,'BASELINE_REQUIRED');const previous=await evaluationStore().run(baseline);if(!current.report||!previous.report)throw new SecurityError(409,'RESULTS_NOT_READY');try{return new BaselineComparator().compare(current.report,previous.report);}catch{throw new SecurityError(409,'INCOMPATIBLE_OR_INVALID_REPORT');}}
