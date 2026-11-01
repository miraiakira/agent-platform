import { z } from 'zod';
import { protectedApi } from './security';
import { approvals } from './persistence';
export function decideApproval(request:Request,params:Promise<{id:string}>,decision:'approved'|'rejected'){
 return protectedApi(request,'approval:decide',async()=>{
  const {id}=await params;
  const body=z.object({reason:z.string().trim().max(500).default('')}).strict().safeParse(await request.json());
  if(!z.uuid().safeParse(id).success||!body.success)return Response.json({error:'INVALID_REQUEST'},{status:400});
  await approvals.decide(id,decision,body.data.reason);return Response.json({ok:true});
 });
}
