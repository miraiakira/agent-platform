import {createHash,createHmac} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {metric} from '@eap/observability';
import {securityContext} from './security-context';
import {SecurityError} from './security';
export function promptCanonical(v:unknown):string {
 if(v===null||typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return JSON.stringify(v);
 if(Array.isArray(v))return `[${v.map(promptCanonical).join(',')}]`;
 if(v&&typeof v==='object')return `{${Object.keys(v).filter(k=>(v as Record<string,unknown>)[k]!==undefined).sort().map(k=>`${JSON.stringify(k)}:${promptCanonical((v as Record<string,unknown>)[k])}`).join(',')}}`;
 throw new SecurityError(400,'INVALID_PROMPT_VALUE');
}
export const promptHash=(v:unknown)=>createHash('sha256').update(promptCanonical(v)).digest('hex');
export interface PromptDocument {template:string;variables_schema:{type:'object';properties:Record<string,{type:'string';maxLength:number}>;required:string[];additionalProperties:false};model_config:{provider:'mock'|'deepseek';model:string}}
export interface PromptPin {prompt_id:string;prompt_version_id:string;prompt_content_hash:string;release_id:string;experiment_id:string|null;variant:'stable'|'canary'|'control'|'treatment';variables:Record<string,string>}
export function validatePromptDocument(input:unknown):PromptDocument {
 const bad=()=>{throw new SecurityError(400,'INVALID_PROMPT_DOCUMENT');};
 if(!input||typeof input!=='object'||Array.isArray(input))return bad();
 const d=input as PromptDocument;
 if(Object.keys(d).sort().join(',')!=='model_config,template,variables_schema'||typeof d.template!=='string'||!d.template.length||d.template.length>16000)return bad();
 const s=d.variables_schema,m=d.model_config;
 if(!s||Object.keys(s).sort().join(',')!=='additionalProperties,properties,required,type'||s.type!=='object'||s.additionalProperties!==false||!s.properties||typeof s.properties!=='object'||Array.isArray(s.properties)||!Array.isArray(s.required))return bad();
 const names=Object.keys(s.properties);if(names.length>16||names.some(k=>!/^[_a-zA-Z][_a-zA-Z0-9]{0,39}$/.test(k)||['__proto__','constructor','prototype'].includes(k))||s.required.length!==names.length||new Set(s.required).size!==names.length||s.required.some(k=>!names.includes(k)))return bad();
 for(const value of Object.values(s.properties))if(!value||Object.keys(value).sort().join(',')!=='maxLength,type'||value.type!=='string'||!Number.isInteger(value.maxLength)||value.maxLength<1||value.maxLength>4000)return bad();
 const slots=[...d.template.matchAll(/\{\{\s*([_a-zA-Z][_a-zA-Z0-9]*)\s*\}\}/g)].map(x=>x[1]!);
 if(slots.some(k=>!names.includes(k))||/\{\{|\}\}/.test(d.template.replace(/\{\{\s*([_a-zA-Z][_a-zA-Z0-9]*)\s*\}\}/g,'')))return bad();
 if(!m||Object.keys(m).sort().join(',')!=='model,provider'||!['mock','deepseek'].includes(m.provider)||typeof m.model!=='string'||!m.model.length||m.model.length>120||m.provider==='mock'&&m.model!=='mock-model')return bad();
 return JSON.parse(promptCanonical(d)) as PromptDocument;
}
/** Variables are explicitly trusted server data only. User/tool text remains in its original message role. */
export function renderPrompt(input:unknown,variables:Record<string,string>):string {
 const d=validatePromptDocument(input),names=Object.keys(d.variables_schema.properties);
 if(Object.keys(variables).some(k=>!names.includes(k))||names.some(k=>!Object.hasOwn(variables,k)||typeof variables[k]!=='string'||variables[k]!.length>d.variables_schema.properties[k]!.maxLength))throw new SecurityError(400,'INVALID_PROMPT_VARIABLES');
 const rendered=d.template.replace(/\{\{\s*([_a-zA-Z][_a-zA-Z0-9]*)\s*\}\}/g,(_,k:string)=>JSON.stringify(variables[k]));
 if(rendered.length>32000)throw new SecurityError(400,'RENDERED_PROMPT_TOO_LARGE');return rendered;
}
export function promptBucket(secret:string,tenant:string,prompt:string,scope:string,unit:string):{hash:string;bucket:number} {
 if(secret.length<32)throw new SecurityError(503,'PROMPT_ROUTING_KEY_REQUIRED');
 const hash=createHmac('sha256',secret).update(JSON.stringify([tenant,prompt,scope,unit])).digest('hex');
 return {hash,bucket:parseInt(hash.slice(0,8),16)/0x100000000*100};
}
export async function promptPolicies(c:Pool|PoolClient){return (await c.query('SELECT tool_name,enabled,allowed_roles,risk_level,requires_approval,policy_version FROM tenant_tool_policies ORDER BY tool_name')).rows;}
export function trustedPromptVariables(d:PromptDocument){
 const variables:Record<string,string>={};for(const k of Object.keys(d.variables_schema.properties)){if(k!=='current_date')throw new SecurityError(409,'UNSUPPORTED_RUNTIME_VARIABLE');variables[k]=new Date().toISOString().slice(0,10);}return variables;
}
export async function verifyPromptPin(c:Pool|PoolClient,pin:PromptPin,input?:unknown){
 const v=(await c.query("SELECT * FROM prompt_versions WHERE id=$1 AND prompt_id=$2 AND status IN ('published','archived')",[pin.prompt_version_id,pin.prompt_id])).rows[0];
 if(!v||v.content_hash!==pin.prompt_content_hash||promptHash(v.document)!==pin.prompt_content_hash)throw new SecurityError(409,'PROMPT_HASH_MISMATCH');
 if((await c.query('SELECT 1 FROM prompt_revocations WHERE version_id=$1',[v.id])).rowCount)throw new SecurityError(403,'PROMPT_REVOKED');
 const d=validatePromptDocument(v.document);
 if(input){const messages=input as {role:string;content:string}[];if(!Array.isArray(messages)||messages[0]?.role!=='system'||messages[0].content!==renderPrompt(d,pin.variables)||messages.slice(1).some(m=>m.role==='system'||m.role==='developer'))throw new SecurityError(409,'PROMPT_INPUT_MISMATCH');}
 return d;
}
export async function resolvePrompt(c:PoolClient,key:string,conversationId:string):Promise<{pin:PromptPin;system:string}|null>{
 const ctx=securityContext()!;
 const definition=(await c.query('SELECT * FROM prompt_definitions WHERE key=$1',[key])).rows[0];
 if(!definition){if(key!=='risk-agent')throw new SecurityError(404,'NOT_FOUND');return null;}
 // Release updates also lock the definition. Resolution and assignment are a single submission snapshot.
 await c.query('SELECT id FROM prompt_definitions WHERE id=$1 FOR SHARE',[definition.id]);
 const release=(await c.query("SELECT * FROM prompt_releases WHERE prompt_id=$1 AND status IN ('active','paused','completed','rolled_back')",[definition.id])).rows[0];
 if(!release)throw new SecurityError(409,'PROMPT_NOT_RELEASED');
 const secret=process.env.PROMPT_ROUTING_KEY??'';
 let version=release.status==='completed'?release.canary_version_id:release.stable_version_id,variant:PromptPin['variant']='stable',experimentId:string|null=null;
 if(['active','paused'].includes(release.status)){
  const experiment=(await c.query("SELECT * FROM prompt_experiments WHERE release_id=$1 AND status IN ('running','paused')",[release.id])).rows[0];
  if(experiment){
   const unit=experiment.assignment_unit==='user'?ctx.actorUserId:conversationId;
   const routed=promptBucket(secret,ctx.tenantId!,definition.id,experiment.id,unit);
   const assigned=(await c.query('SELECT * FROM eap_prompt_assign($1,$2,$3)',[experiment.id,routed.hash,routed.bucket])).rows[0];
   if(assigned){version=assigned.assigned_version_id;variant=assigned.variant;experimentId=experiment.id;metric('agent_prompt_experiment_assignments_total',1,{status:variant});}
  }else if(release.status==='active'&&promptBucket(secret,ctx.tenantId!,definition.id,release.id,conversationId).bucket<release.canary_percentage){version=release.canary_version_id;variant='canary';}
 }
 const v=(await c.query('SELECT * FROM prompt_versions WHERE id=$1',[version])).rows[0];
 if(!v)throw new SecurityError(409,'PROMPT_UNAVAILABLE');
 const document=validatePromptDocument(v.document),variables=trustedPromptVariables(document);
 const pin:PromptPin={prompt_id:definition.id,prompt_version_id:v.id,prompt_content_hash:v.content_hash,release_id:release.id,experiment_id:experimentId,variant,variables};
 await verifyPromptPin(c,pin);metric('agent_prompt_resolutions_total',1,{status:variant,prompt_version:v.version<=20?String(v.version):'other'});
 return {pin,system:renderPrompt(document,variables)};
}
