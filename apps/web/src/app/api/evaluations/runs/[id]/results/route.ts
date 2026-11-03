import {evaluationApi,evaluationStore,evaluationId} from '@/lib/evaluation-api';
export async function GET(r:Request,{params}:{params:Promise<{id:string}>}){return evaluationApi(r,'evaluation:read',async()=>Response.json({results:await evaluationStore().results(await evaluationId(params))}));}
