import { z } from 'zod';
import { protectedApi } from '@/lib/security';
import { approvals } from '@/lib/persistence';
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){return protectedApi(request,'approval:read',async()=>{
 const {id}=await params;if(!z.uuid().safeParse(id).success)return Response.json({error:'INVALID_ID'},{status:400});
 const [approval]=await approvals.list(id);return approval?Response.json({approval}):Response.json({error:'NOT_FOUND'},{status:404});
});}
