import { withSecurityContext, SecurityError, type Permission } from '@eap/persistence';
import { getAuth } from './auth';
import { security } from './persistence';
export function checkOrigin(request:Request) {
 const expected=process.env.BETTER_AUTH_URL;
 if(!expected) throw new SecurityError(503,'SECURITY_UNCONFIGURED');
 const origin=request.headers.get('origin');
 if((origin && origin!==new URL(expected).origin) || (!['GET','HEAD'].includes(request.method) && !origin) || request.headers.get('sec-fetch-site')==='cross-site') throw new SecurityError(403,'INVALID_ORIGIN');
}
export function securityResponse(error:unknown) {
 if(error instanceof SyntaxError) return Response.json({error:'INVALID_JSON'},{status:400});
 if(error instanceof SecurityError) return Response.json({error:error.code},{status:error.status,headers:error.retryAfter?{'Retry-After':String(error.retryAfter)}:undefined});
 return Response.json({error:'Service unavailable'},{status:503});
}
export async function authenticated<T>(request:Request,fn:(actor:string)=>Promise<T>):Promise<T|Response> {
 try {
  checkOrigin(request);
  const session=await (await getAuth()).api.getSession({headers:request.headers,query:{disableCookieCache:true}});
  if(!session) throw new SecurityError(401,'UNAUTHENTICATED');
  return await withSecurityContext({actorUserId:session.user.id},()=>fn(session.user.id));
 }catch(error){return securityResponse(error);}
}
export async function protectedApi(request:Request,permission:Permission,fn:()=>Promise<Response>):Promise<Response> {
 return await authenticated(request,async actor=>{
  const url=new URL(request.url);
  // Cookie is only a selector, never evidence of membership; query is needed for EventSource.
  const tenant=request.headers.get('x-tenant-id')??url.searchParams.get('tenant')??request.headers.get('cookie')?.match(/(?:^|;\s*)eap_tenant=([0-9a-f-]+)/)?.[1];
  if(!tenant || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenant)) throw new SecurityError(403,'TENANT_REQUIRED');
  return withSecurityContext({tenantId:tenant,actorUserId:actor},async()=>{
   await security.authorize(permission);
   await security.limit(`tenant:${tenant}`,120,60);
   try { return await fn(); } catch(error) {
    if(error instanceof SecurityError) await security.audit("api.request","api",null,"deny",error.code);
    throw error;
   }
  });
 }) as Response;
}
