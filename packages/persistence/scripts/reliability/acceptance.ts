import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {artifacts,metadata,save} from './common';
type Status='PASS'|'FAIL'|'NOT VERIFIED';
interface Report {
 status?:string;generated_at?:string;source_sha256?:string;revision?:string;
 exit_code?:number;failed_assertions?:number;
 results?:{name:string;status:string}[];
 checks?:{grade:string;critical:boolean;verification:string}[];
}
const current=await metadata('day14-acceptance'),now=Date.now();
const evidence:Record<string,{file:string;status:Status;reason:string;generated_at?:string;source_sha256?:string;revision?:string}>={};
const get=async(name:string):Promise<Report|undefined>=>{
 try {
  const value:unknown=JSON.parse(await readFile(resolve(artifacts,name,'report.json'),'utf8'));
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid report');
  const r=value as Report;
  if(r.results!==undefined&&(!Array.isArray(r.results)||r.results.some(x=>!x||typeof x.name!=='string'||typeof x.status!=='string')))throw new Error('Invalid results');
  if(r.checks!==undefined&&(!Array.isArray(r.checks)||r.checks.some(x=>!x||typeof x.grade!=='string'||typeof x.verification!=='string'||typeof x.critical!=='boolean')))throw new Error('Invalid checks');
  const reasons:string[]=[],time=Date.parse(r.generated_at??'');
  if(!Number.isFinite(time)||time>now+5000||now-time>86400000)reasons.push('Expired or invalid execution timestamp.');
  if(r.source_sha256!==current.source_sha256)reasons.push('Source SHA mismatch.');
  if(r.revision!==current.revision)reasons.push('Git revision mismatch.');
  const failed=r.status==='FAIL'||r.results?.some(x=>x.status==='FAIL')||r.checks?.some(x=>x.grade==='FAIL')||
   (typeof r.exit_code==='number'&&r.exit_code!==0)||(typeof r.failed_assertions==='number'&&r.failed_assertions>0);
  const complete=(r.status==='PASS'||!!r.results?.length)&&(r.status===undefined||r.status==='PASS')&&
   (!r.results||r.results.every(x=>x.status==='PASS'))&&
   (!r.checks||r.checks.every(x=>x.grade!=='FAIL'&&(!x.critical||['VERIFIED','NOT APPLICABLE'].includes(x.verification))));
  if(failed)reasons.push('Recorded execution contains a failure.');
  else if(!complete)reasons.push('Successful execution is not fully evidenced.');
  const status:Status=failed?'FAIL':complete&&!reasons.length?'PASS':'NOT VERIFIED';
  evidence[name]={file:`${name}/report.json`,status,reason:reasons.join(' ')||'Fresh successful evidence bound to source and revision.',
   generated_at:r.generated_at,source_sha256:r.source_sha256,revision:r.revision};
  // Preserve observed failures, but do not accept category PASS from invalid suites.
  // The source report remains untouched; raw observations remain in its file.
  return {...r,status,results:r.results?.map(x=>({...x,status:x.status==='FAIL'?'FAIL':status==='PASS'&&x.status==='PASS'?'PASS':'NOT VERIFIED'}))};
 }catch{evidence[name]={file:`${name}/report.json`,status:'NOT VERIFIED',reason:'Missing, unreadable or malformed evidence.'};return undefined;}
};
const faults=await get('faults'),backup=await get('backup-restore'),regression=await get('regression'),browser=await get('browser'),readiness=await get('readiness'),alerts=await get('alerts');
const results:{name:string;status:string;scope?:string}[]=[];
results.push({name:'FaultSuites',status:faults?.status??'NOT VERIFIED',scope:'Package results and failed assertion count; category mappings cannot hide suite failures.'});
for(const mode of ['smoke','baseline','stress','spike','soak']){const r=await get(`load/${mode}`);results.push({name:`Load ${mode}`,status:r?.status??'NOT VERIFIED',scope:mode==='soak'?'Recorded local duration; long production soak NOT VERIFIED':'Isolated Mock fixture measurement, not a production SLO'});}
for(const [name,key] of Object.entries({QueueSaturation:'queue_saturation',TenantFairness:'tenant_fairness',WorkerCrash:'worker_crash',LeaseExpiry:'lease_expiry',Fencing:'fencing',DBDisconnect:'db_disconnect',ModelTimeout:'model_timeout',ToolUncertainOutcome:'tool_uncertain_outcome',SSEResume:'sse_resume',HITLResume:'hitl_resume',PromptPinning:'prompt_pinning',KnowledgeACLRevocation:'knowledge_acl',MemoryDelete:'memory_delete',GracefulShutdown:'graceful_shutdown'}))results.push({name,status:faults?.results?.find((r:{name:string})=>r.name===key)?.status??'NOT VERIFIED'});
for(const [name,key] of [['Backup','pg_dump'],['Restore','pg_restore'],['RLSVerification','cross_tenant_isolation']])results.push({name,status:backup?.results?.find((r:{name:string})=>r.name===key)?.status??'NOT VERIFIED'});
results.push({name:'SLOCalculation',status:faults?.results?.find((r:{name:string})=>r.name==='slo_calculation')?.status??'NOT VERIFIED'},{name:'AlertRules',status:alerts?.status??'NOT VERIFIED'},{name:'ReadinessCheckerTests',status:faults?.results?.find((r:{name:string})=>r.name==='readiness_gate')?.status??'NOT VERIFIED',scope:'Checker tests only; production readiness is separate'},{name:'Day1-13Regression',status:regression?.status==='FAIL'||browser?.status==='FAIL'?'FAIL':regression?.status==='PASS'&&browser?.status==='PASS'?'PASS':'NOT VERIFIED'});
const status:Status=results.some(r=>r.status==='FAIL')?'FAIL':results.every(r=>r.status==='PASS')?'PASS':'NOT VERIFIED';
await save('acceptance',{
 ...current,status,results,evidence,
 production_readiness:readiness?.status==='PASS'?'VERIFIED':'NOT VERIFIED',remote_ci:'NOT VERIFIED',freeze:false,
 notes:['Summary generation does not refresh execution evidence.',
  'Recorded failures remain failures when stale; invalid successful evidence is NOT VERIFIED.',
  'A freeze still requires matching remote CI, production evidence/manual review and an approved capacity plan.'],
},`# Day 14 Acceptance\n\nResult: ${status}\n\n| Item | Result | Scope |\n|---|---|---|\n${results.map(r=>`| ${r.name} | ${r.status} | ${r.scope??'See bound execution evidence below'} |`).join('\n')}\n\n| Evidence | Status | Reason |\n|---|---|---|\n${Object.entries(evidence).map(([name,e])=>`| ${name} | ${e.status} | ${e.reason} |`).join('\n')}\n\nProduction readiness: ${readiness?.status??'NOT VERIFIED'}. Remote CI: NOT VERIFIED. Freeze: no.\n`);
console.log(JSON.stringify({status,results,evidence,freeze:false}));
process.exitCode=status==='PASS'?0:status==='FAIL'?1:2;
