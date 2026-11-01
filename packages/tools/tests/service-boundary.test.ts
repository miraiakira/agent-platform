import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { createBusinessTools } from '../src/transactions';
const servers: Server[]=[];
async function listen(server:Server){servers.push(server);server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw new Error('No test address');return `http://127.0.0.1:${address.port}`;}
afterEach(async()=>{await Promise.all(servers.splice(0).map(server=>new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();})));});
const identity={tenantId:'00000000-0000-0000-0000-000000000001',actorUserId:'trusted-actor',policyVersion:1};
it('sends service credentials and server-side context, and rejects attempted model context overrides',async()=>{
 const requests:Array<Record<string,unknown>>=[];
 const baseURL=await listen(createServer((req,res)=>{requests.push({key:req.headers.authorization,tenant:req.headers['x-eap-tenant-id'],actor:req.headers['x-eap-actor-id']});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({items:[],total:0}));}));
 const tools=createBusinessTools({baseURL,apiKey:'test-service-key-with-at-least-32-characters',authorize:async()=>identity});
 const args={date:'2026-11-01',limit:3};
 await tools.execute('get_high_risk_transactions',JSON.stringify(args));
 expect(requests).toEqual([{key:'Bearer test-service-key-with-at-least-32-characters',tenant:identity.tenantId,actor:identity.actorUserId}]);
 for(const override of [{tenant_id:'other'},{tenantId:'other'},{actor_user_id:'attacker'},{actorUserId:'attacker'},{headers:{Authorization:'Bearer attacker'}}])await expect(tools.execute('get_high_risk_transactions',JSON.stringify({...args,...override}))).rejects.toMatchObject({code:'INVALID_ARGUMENTS'});
 expect(requests).toHaveLength(1);
});
it('never follows redirects with internal identity headers',async()=>{
 let downstream=0;
 const destination=await listen(createServer((_req,res)=>{downstream++;res.end('{}');}));
 const baseURL=await listen(createServer((_req,res)=>{res.writeHead(302,{Location:destination+'/stolen'});res.end();}));
 const tools=createBusinessTools({baseURL,apiKey:'test-service-key-with-at-least-32-characters',authorize:async()=>identity});
 await expect(tools.execute('get_high_risk_transactions',JSON.stringify({date:'2026-11-01',limit:3}))).rejects.toMatchObject({code:'UPSTREAM_ERROR'});
 expect(downstream).toBe(0);
});
