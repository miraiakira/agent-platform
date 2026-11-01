import { protectedApi } from '@/lib/security';
import { store } from '@/lib/persistence';
export async function GET(request:Request){
 return protectedApi(request,'agent:read',async()=>Response.json({runs:await store.listRecentJobs()}));
}
