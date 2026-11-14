// Test-facility diagnostics only. Never serialize arbitrary messages, stacks, URLs or env.
export interface SafeError {
 code?: string; syscall?: string; address?: string; port?: number;
 causes?: SafeError[];
}
export function safeError(error: unknown, depth = 0): SafeError {
 if (!error || typeof error !== 'object' || depth > 3) return {};
 const e = error as {code?:unknown;syscall?:unknown;address?:unknown;port?:unknown;cause?:unknown;errors?:unknown};
 const result: SafeError = {};
 if (typeof e.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(e.code)) result.code = e.code;
 if (typeof e.syscall === 'string' && /^(connect|getaddrinfo|read|write|listen|kill|spawn)$/.test(e.syscall)) result.syscall = e.syscall;
 if (typeof e.address === 'string' && /^(localhost|[0-9.]{1,45}|[0-9a-f:]{1,45})$/i.test(e.address)) result.address = e.address;
 if (typeof e.port === 'number' && Number.isInteger(e.port) && e.port > 0 && e.port <= 65535) result.port = e.port;
 const causes = [...(Array.isArray(e.errors) ? e.errors.slice(0,4) : []), ...(e.cause ? [e.cause] : [])];
 if (causes.length && depth < 3) result.causes = causes.map(cause => safeError(cause, depth + 1));
 return result;
}
export interface CleanupResult {
 step: string; status: 'PASS'|'FAIL'; duration_ms: number;
 error?: SafeError; timed_out?: boolean; children?: CleanupResult[];
}
export class CleanupError extends AggregateError {
 readonly code = 'FIXTURE_CLEANUP_FAILED';
 constructor(readonly results: CleanupResult[], errors: unknown[]) { super(errors, 'Fixture cleanup failed; inspect step diagnostics'); }
}
export async function cleanupSteps(steps: {step:string;run:()=>Promise<void|CleanupResult[]>;timeoutMs?:number}[], timeoutMs = 5000): Promise<CleanupResult[]> {
 const results: CleanupResult[] = [], errors: unknown[] = [];
 for (const {step,run,timeoutMs:stepTimeout} of steps) {
  const started = performance.now(); let timer:ReturnType<typeof setTimeout>|undefined, timedOut = false;
  try {
   const children = await Promise.race([Promise.resolve().then(run),new Promise<never>((_,reject)=>{
    timer=setTimeout(()=>{timedOut=true;reject(Object.assign(new Error('Cleanup step timeout'),{code:'CLEANUP_TIMEOUT'}));},stepTimeout??timeoutMs);
   })]);
   results.push({step,status:'PASS',duration_ms:Math.round(performance.now()-started),...(children?{children}:{})});
  } catch(error) {
   errors.push(error);
   results.push({step,status:'FAIL',duration_ms:Math.round(performance.now()-started),error:safeError(error),
    ...(timedOut?{timed_out:true}:{}),...(error instanceof CleanupError?{children:error.results}:{})});
  } finally { if(timer)clearTimeout(timer); }
 }
 if(errors.length)throw new CleanupError(results,errors);
 return results;
}

export function capacityEvidenceFresh(report:Record<string,unknown>, source:string, revision:string, startedAt:number):boolean {
 const generated=Date.parse(String(report.generated_at??''));
 return report.source_sha256===source &&
  report.revision===revision && Number.isFinite(generated) && generated>=startedAt && generated<=Date.now()+5000;
}
export function capacityEvidenceValid(code:number, report:Record<string,unknown>, source:string, revision:string, startedAt:number):boolean {
 return code===0 && report.status==='PASS' && report.cleanup==='PASS' && capacityEvidenceFresh(report,source,revision,startedAt);
}
