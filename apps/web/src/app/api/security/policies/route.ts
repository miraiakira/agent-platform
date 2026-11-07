import { z } from 'zod';
import { roles } from '@eap/persistence';
import { protectedApi } from '@/lib/security';
import { security } from '@/lib/persistence';
export async function GET(r:Request){return protectedApi(r,'conversation:read',async()=>Response.json({policies:await security.policies()}));}
export async function POST(r:Request){return protectedApi(r,'tool:manage',async()=>{
 const b=z.object({tool_name:z.enum(['get_high_risk_transactions','search_knowledge','memory_search','memory_list','memory_write','memory_delete']),enabled:z.boolean(),allowed_roles:z.array(z.enum(roles)),risk_level:z.enum(['low','high']),requires_approval:z.boolean()}).strict().safeParse(await r.json());
 if(!b.success)return Response.json({error:'Invalid request'},{status:400});
 await security.setPolicy(b.data);return Response.json({ok:true});
});}
