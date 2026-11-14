import http from 'k6/http';
import {sleep} from 'k6';
import execution from 'k6/execution';
import {Counter,Rate,Trend} from 'k6/metrics';
const fixture=JSON.parse(open(__ENV.FIXTURE_FILE||'/fixture/context.json'));
if(fixture.scope!=='isolated-fixture'||!/^http:\/\/(localhost|127\.0\.0\.1|host\.docker\.internal):3554$/.test(fixture.base))throw new Error('Isolated load target required');
const mode=__ENV.LOAD_MODE||'smoke';
const stages={smoke:[{duration:'30s',target:2}],baseline:[{duration:'30s',target:10},{duration:'30s',target:25},{duration:'30s',target:50}],stress:[{duration:'5s',target:50},{duration:'15s',target:50},{duration:'5s',target:100},{duration:'15s',target:100},{duration:'5s',target:150},{duration:'15s',target:150}],spike:[{duration:'10s',target:2},{duration:'10s',target:100},{duration:'20s',target:100},{duration:'20s',target:2}],soak:[{duration:__ENV.SOAK_DURATION||'120s',target:10}]};
if(!stages[mode])throw new Error('Unknown profile');
const scenarios=mode==='baseline'?{p10:{executor:'constant-vus',vus:10,duration:'30s',startTime:'0s',gracefulStop:'5s'},p25:{executor:'constant-vus',vus:25,duration:'30s',startTime:'35s',gracefulStop:'5s'},p50:{executor:'constant-vus',vus:50,duration:'30s',startTime:'70s',gracefulStop:'5s'}}:mode==='smoke'||mode==='soak'?{default:{executor:'constant-vus',vus:mode==='smoke'?2:10,duration:mode==='smoke'?'30s':(__ENV.SOAK_DURATION||'120s'),gracefulStop:'10s'}}:{default:{executor:'ramping-vus',stages:stages[mode],startVUs:1,gracefulRampDown:'5s',gracefulStop:'10s'}};
export const options={scenarios,summaryTrendStats:['avg','med','p(95)','p(99)','max'],systemTags:['status','method','name','scenario','expected_response'],thresholds:mode==='smoke'?{unexpected_errors:['rate<0.05'],accepted_jobs:['count>0'],http_reqs:['count>0']}:{http_reqs:['count>0']}};
const accepted=new Counter('accepted_jobs'),rejected=new Rate('rate_limited'),errors=new Rate('unexpected_errors'),sseDisconnects=new Counter('sse_disconnects'),retrieval=new Trend('retrieval_ms');
const phaseTrends={p10:new Trend('http_duration_p10'),p25:new Trend('http_duration_p25'),p50:new Trend('http_duration_p50')};
let previous;
export default function(){
 const tenant=fixture.tenants[(__VU-1)%fixture.tenants.length];const pathKind=__ITER%10;
 const headers={Cookie:fixture.cookie,Origin:fixture.origin,'x-tenant-id':tenant.id,'Content-Type':'application/json'};
 const request=(method,path,body,name)=>{const r=http.request(method,fixture.base+path,body===undefined?null:JSON.stringify(body),{headers,timeout:name==='sse'?'2s':'10s',redirects:0,tags:{name}});if(phaseTrends[execution.scenario.name])phaseTrends[execution.scenario.name].add(r.timings.duration);const limited=r.status===429||r.status===503&&r.body&&r.body.includes('GLOBAL_CAPACITY_LIMIT');rejected.add(limited);const disconnected=name==='sse'&&r.status===0;if(disconnected)sseDisconnects.add(1);errors.add(!limited&&!disconnected&&(r.status<200||r.status>=400));return r;};
 if(pathKind===0)request('GET','/api/health',undefined,'health');
 else if(pathKind===1||pathKind===2){headers['Idempotency-Key']=`load-${__VU}-${__ITER}-${Date.now()}`;const body={messages:[{role:'user',content:'Query high-risk transactions'}]};const r=request('POST','/api/agent/jobs',body,'job-submit');if(r.status===202){accepted.add(1);previous=r.json('runId');if(__ITER%20===1){const repeated=request('POST','/api/agent/jobs',body,'job-idempotency');if(repeated.status===202&&repeated.json('runId')!==previous)errors.add(true);}}}
 else if(pathKind===3&&previous)request('GET','/api/agent/runs/'+previous,undefined,'job-status');
 else if(pathKind===4&&previous)request('GET','/api/agent/runs/'+previous+'/events',undefined,'sse');
 else if(pathKind===5)request('GET','/api/evaluations/runs',undefined,'evaluation-query');
 else if(pathKind===6)request('GET',tenant.prompt?'/api/prompts/'+tenant.prompt:'/api/prompts',undefined,'prompt-query');
 else if(pathKind===7){const r=request('POST','/api/knowledge/search',{query:'refund policy',knowledge_base_ids:[tenant.kb],top_k:3,mode:'hybrid'},'knowledge-retrieval');if(r.status===200)retrieval.add(r.timings.duration);}
 else if(pathKind===8)request('GET','/api/memories?query=concise',undefined,'memory-search');
 else request('GET','/api/agent/runs',undefined,'job-list');
 sleep(0.2);
}
export function handleSummary(data){return {[__ENV.REPORT_FILE||'/reports/k6.json']:JSON.stringify(data,null,2),stdout:JSON.stringify({profile:mode,requests:data.metrics.http_reqs?.values,accepted:data.metrics.accepted_jobs?.values,errors:data.metrics.unexpected_errors?.values})+'\n'};}
