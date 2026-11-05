import {promptApi} from '@/lib/prompt-api';
import {evaluationBody} from '@/lib/evaluation-api';
export async function GET(r:Request){return promptApi(r,'prompt:read',async s=>Response.json({prompts:await s.list()}));}
export async function POST(r:Request){return promptApi(r,'prompt:edit',async s=>Response.json({prompt:await s.create(await evaluationBody(r))},{status:201}));}
