import { toNextJsHandler } from 'better-auth/next-js';
import { getAuth, auditAuthFailure } from '@/lib/auth';
import { securityResponse } from '@/lib/security';
import { SecurityStore } from '@eap/persistence';
import { createPool } from '@eap/persistence';
import { scopedPool } from '@eap/persistence';
export const runtime='nodejs';
// Global shared bucket cannot be bypassed by spoofing client IP headers.
let limiter:SecurityStore|undefined;
async function handle(request:Request) {
 try {
  const auth=await getAuth();
  limiter??=new SecurityStore(scopedPool(createPool(),'eap_app'));
  await limiter.limit('auth:global',100,60);
  const response=await toNextJsHandler(auth)[request.method==='GET'?'GET':'POST'](request);
  if(response.status>=400) await auditAuthFailure();
  return response;
 } catch(error){return securityResponse(error);}
}
export const GET=handle;
export const POST=handle;
