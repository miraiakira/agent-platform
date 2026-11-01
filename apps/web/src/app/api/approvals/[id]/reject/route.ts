import { decideApproval } from '@/lib/approval-decision';
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){return decideApproval(request,params,'rejected');}
