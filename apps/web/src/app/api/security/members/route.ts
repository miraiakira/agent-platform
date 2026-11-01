import { z } from 'zod';
import { roles } from '@eap/persistence';
import { protectedApi } from '@/lib/security';
import { security } from '@/lib/persistence';
export async function GET(r:Request){return protectedApi(r,'conversation:read',async()=>Response.json({members:await security.members()}));}
export async function POST(r:Request){return protectedApi(r,'member:manage',async()=>{
 const b=z.object({userId:z.string().min(1).max(128),role:z.enum(roles),status:z.enum(['active','removed'])}).strict().safeParse(await r.json());
 if(!b.success)return Response.json({error:'Invalid request'},{status:400});
 await security.changeMember(b.data.userId,b.data.role,b.data.status);return Response.json({ok:true});
});}
