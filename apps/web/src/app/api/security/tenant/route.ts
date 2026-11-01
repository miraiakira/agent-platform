import { z } from 'zod';
import { protectedApi } from '@/lib/security';
import { security } from '@/lib/persistence';
export async function POST(r:Request){return protectedApi(r,'tenant:manage',async()=>{
 const b=z.object({status:z.enum(['active','disabled'])}).strict().safeParse(await r.json());
 if(!b.success)return Response.json({error:'Invalid request'},{status:400});
 await security.setTenant(b.data.status);return Response.json({ok:true});
});}
