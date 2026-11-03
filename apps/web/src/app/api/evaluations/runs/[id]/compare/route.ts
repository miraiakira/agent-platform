import {evaluationApi,evaluationId,compareRun} from '@/lib/evaluation-api';
export async function GET(r:Request,{params}:{params:Promise<{id:string}>}){return evaluationApi(r,'evaluation:read',async()=>Response.json({comparison:await compareRun(await evaluationId(params),new URL(r.url).searchParams.get('baseline')??undefined)}));}
