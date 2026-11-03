import {evaluationApi,evaluationStore,evaluationId} from '@/lib/evaluation-api';
export async function POST(r:Request,{params}:{params:Promise<{id:string}>}){return evaluationApi(r,'evaluation:run',async()=>{await evaluationStore().cancel(await evaluationId(params));return Response.json({ok:true});});}
