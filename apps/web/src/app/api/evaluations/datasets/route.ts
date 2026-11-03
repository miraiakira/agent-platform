import {z} from 'zod';
import {evaluationApi,evaluationStore,evaluationBody} from '@/lib/evaluation-api';
import {security} from '@/lib/persistence';
import {securityContext} from '@eap/persistence';
export async function GET(r:Request){return evaluationApi(r,'evaluation:read',async()=>Response.json({datasets:await evaluationStore().datasets()}));}
export async function POST(r:Request){return evaluationApi(r,'evaluation:manage',async()=>{
 await security.limit(`eval-import:${securityContext()?.tenantId}`,10,60);
 const body=z.object({dataset:z.unknown(),dataset_id:z.uuid().optional()}).strict().parse(await evaluationBody(r));return Response.json(await evaluationStore().publish(body.dataset,body.dataset_id),{status:201});
});}
