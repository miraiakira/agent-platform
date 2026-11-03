import {evaluationApi,evaluationStore,evaluationBody,runInputSchema} from '@/lib/evaluation-api';
import {security} from '@/lib/persistence';
import {securityContext} from '@eap/persistence';
export async function GET(r:Request){return evaluationApi(r,'evaluation:read',async()=>Response.json({runs:await evaluationStore().runs()}));}
export async function POST(r:Request){return evaluationApi(r,'evaluation:run',async()=>{
 await security.limit(`eval-submit:${securityContext()?.tenantId}`,10,60);const body=runInputSchema.parse(await evaluationBody(r));const config={...body.config,code_revision:process.env.EVAL_CODE_REVISION??process.env.GITHUB_SHA??'working-tree'};
 return Response.json(await evaluationStore().submit(body.dataset_version_id,config,body.baseline_run_id,body.gate),{status:202});
});}
