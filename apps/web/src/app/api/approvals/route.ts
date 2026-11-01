import { protectedApi } from '@/lib/security';
import { approvals } from '@/lib/persistence';
export async function GET(request:Request){return protectedApi(request,'approval:read',async()=>Response.json({approvals:await approvals.list()}));}
