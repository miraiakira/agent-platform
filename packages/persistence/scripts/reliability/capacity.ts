import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {run,artifacts,metadata,save} from './common';
import {capacityEvidenceFresh,capacityEvidenceValid,safeError} from './diagnostics';
const rows:Record<string,unknown>[]=[];
const current=await metadata('capacity-baseline');let stoppedAfter:string|undefined;
for(const mode of ['smoke','baseline','stress','spike','soak']){
 if(stoppedAfter){rows.push({profile:mode,status:'NOT RUN',reason:'PREVIOUS_PROFILE_FAILED',stopped_after:stoppedAfter});continue;}
 const startedAt=Date.now();let code=1;
 try{code=await run('pnpm',['load:test',mode],process.env,b=>process.stdout.write(b));}
 catch(error){rows.push({profile:mode,status:'FAIL',reason:'PROFILE_LAUNCH_FAILED',error:safeError(error)});stoppedAfter=mode;process.exitCode=1;continue;}
 try{
  const r=JSON.parse(await readFile(resolve(artifacts,'load',mode,'report.json'),'utf8'));
  if(!capacityEvidenceFresh(r,current.source_sha256,current.revision,startedAt)){
   rows.push({profile:mode,status:'FAIL',reason:'STALE_OR_SOURCE_MISMATCHED_EVIDENCE',exit_code:code});
   stoppedAfter=mode;process.exitCode=1;continue;
  }
  const valid=capacityEvidenceValid(code,r,current.source_sha256,current.revision,startedAt);
  rows.push({profile:mode,status:valid?'PASS':'FAIL',cleanup:r.cleanup??'NOT VERIFIED',exit_code:code,
   reason:valid?undefined:'PROFILE_FAILED_OR_EVIDENCE_INVALID',duration_seconds:r.duration_seconds,rps:r.k6?.metrics?.http_reqs?.values?.rate,http_p95_ms:r.k6?.metrics?.http_req_duration?.values?.['p(95)'],http_p99_ms:r.k6?.metrics?.http_req_duration?.values?.['p(99)'],rate_limited:r.k6?.metrics?.rate_limited?.values?.rate,unexpected_errors:r.k6?.metrics?.unexpected_errors?.values?.rate,accepted:r.jobs?.accepted,completed:r.jobs?.completed,queue_wait_p95_ms:r.jobs?.queue_wait_p95_ms,execution_p95_ms:r.jobs?.execution_p95_ms,recovery_ms:r.recovery_ms,qualification:r.qualification});
  if(!valid){stoppedAfter=mode;process.exitCode=1;}
 }catch(error){rows.push({profile:mode,status:'FAIL',reason:'MISSING_OR_INVALID_EVIDENCE',error:safeError(error)});stoppedAfter=mode;process.exitCode=1;}
}
await save('capacity',{...current,completed_at:new Date().toISOString(),stopped_after:stoppedAfter,status:rows.every(r=>r.status==='PASS')?'PASS':'FAIL',results:rows,notes:['These are constrained local fixture measurements, not production capacity commitments.','Existing rate limits remain enabled; compare profiles and per-phase p10/p25/p50 trends before inferring a throughput knee.','Long production soak and native process resource caps remain NOT VERIFIED.']},`# Local Capacity Baseline\n\n| Profile | Status | Seconds | RPS | HTTP P95 ms | HTTP P99 ms | Limited | Accepted | Completed |\n|---|---|---|---|---|---|---|---|---|\n${rows.map(r=>`| ${r.profile} | ${r.status} | ${r.duration_seconds} | ${r.rps} | ${r.http_p95_ms} | ${r.http_p99_ms} | ${r.rate_limited} | ${r.accepted} | ${r.completed} |`).join('\n')}\n\nProposed latency SLOs are not achieved production SLOs. See individual profile reports for hardware, quotas, data scale, samples and failures.\n`);
