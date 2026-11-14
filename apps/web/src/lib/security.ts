import {metric} from '@eap/observability';
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
 const started=performance.now();
 const response=await authenticated(request,async actor=>{
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
 const path=new URL(request.url).pathname;
 const route=path==='/api/agent/jobs'?'agent_submit':path.startsWith('/api/agent/runs')?(path.endsWith('/events')?'agent_events':'agent_status'):path.startsWith('/api/knowledge')?'knowledge':path.startsWith('/api/memories')?'memory':path.startsWith('/api/prompts')?'prompt':path.startsWith('/api/evaluations')?'evaluation':'other';
 const status=response.status>=500?'server_error':response.status===429?'limited':response.status>=400?'client_error':'success';
 metric('http_requests_total',1,{route,status});if(route!=='agent_events')metric('http_request_duration_seconds',(performance.now()-started)/1000,{route,status});
 if(route==='agent_submit')metric('agent_submission_total',1,{status:response.status===202?'accepted':response.status===429||response.status===503?'capacity_or_unavailable':response.status>=500?'server_error':'invalid_or_denied'});
 return response;
}

export async function boundedJson(request:Request,maxBytes=1_000_000):Promise<unknown>{
 if(Number(request.headers.get('content-length')??0)>maxBytes)throw new SecurityError(413,'REQUEST_TOO_LARGE');
 const reader=request.body?.getReader();if(!reader)throw new SyntaxError('Missing JSON');let size=0;const chunks:Uint8Array[]=[];
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes){await reader.cancel();throw new SecurityError(413,'REQUEST_TOO_LARGE');}chunks.push(value);}}finally{reader.releaseLock();}
 return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
