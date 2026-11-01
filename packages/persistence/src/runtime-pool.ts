import { createPool } from './db';
import { assertRuntimeRole, scopedPool } from './security-context';
export function createRuntimePool(role:'eap_app'|'eap_worker') {
 const raw=createPool();
 let checked:Promise<void>|undefined;
 const scope=scopedPool(raw,role);
 return new Proxy(scope,{get(target,prop){
  if(prop==='connect' || prop==='query') return async (...args:unknown[])=>{
   checked??=assertRuntimeRole(raw);
   await checked;
   const method=Reflect.get(target,prop) as (...args:unknown[])=>unknown;
   return method(...args);
  };
  return Reflect.get(target,prop);
 }});
}
