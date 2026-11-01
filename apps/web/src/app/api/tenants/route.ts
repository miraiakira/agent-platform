import { z } from 'zod';
import { authenticated } from '@/lib/security';
import { security } from '@/lib/persistence';
export const runtime='nodejs';
export async function GET(request:Request){return authenticated(request,async()=>Response.json({tenants:await security.listTenants()}));}
export async function POST(request:Request){return authenticated(request,async()=>{
 const body=z.object({name:z.string().trim().min(1).max(120)}).strict().safeParse(await request.json());
 if(!body.success)return Response.json({error:'Invalid request'},{status:400});
 await security.limit('tenant-create:global',30,60);
 return Response.json({tenant:await security.createTenant(body.data.name)},{status:201});
});}
