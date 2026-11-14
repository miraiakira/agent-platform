import {describe,it,expect,vi} from 'vitest';
import {safeError,cleanupSteps,CleanupError,capacityEvidenceValid} from '../scripts/reliability/diagnostics';

describe('test harness diagnostics',()=>{
 it('keeps connection facts while omitting credentials, messages and stacks, including nested causes',()=>{
  const secret='postgresql://user:private-password@localhost/eap_test';
  const error=Object.assign(new Error(secret),{code:'ECONNREFUSED',syscall:'connect',address:'127.0.0.1',port:5544,
   cause:Object.assign(new Error('Cookie: private-session'),{code:'ECONNRESET'}),url:secret});
  expect(safeError(error)).toEqual({code:'ECONNREFUSED',syscall:'connect',address:'127.0.0.1',port:5544,causes:[{code:'ECONNRESET'}]});
  expect(JSON.stringify(safeError(error))).not.toContain('private');
 });
 it('bounds cyclic and aggregated error traversal',()=>{
  const error:{cause?:unknown;errors?:unknown[];code:string}={code:'ECONNREFUSED'};error.cause=error;error.errors=Array(20).fill(error);
  expect(JSON.stringify(safeError(error)).length).toBeLessThan(20000);
 });
 it('still closes remaining resources after a role deletion failure and reports the failed step',async()=>{
  const ran:string[]=[];
  try{
   await cleanupSteps([
    {step:'role.drop',run:async()=>{ran.push('role');throw Object.assign(new Error('secret'),{code:'ECONNREFUSED'});}},
    {step:'schema.close',run:async()=>{ran.push('schema');}},
    {step:'admin.end',run:async()=>{ran.push('admin');}},
   ]);throw new Error('Expected cleanup to fail');
  }catch(error){
   expect(error).toBeInstanceOf(CleanupError);const results=(error as CleanupError).results;
   expect(results.map(r=>[r.step,r.status])).toEqual([['role.drop','FAIL'],['schema.close','PASS'],['admin.end','PASS']]);
   expect(ran).toEqual(['role','schema','admin']);
  }
 });
 it('records a timeout as failure and attempts the next cleanup step',async()=>{
  vi.useFakeTimers();
  try{
   const next=vi.fn(async()=>{});
   const promise=cleanupSteps([{step:'blocked',run:()=>new Promise<void>(()=>{})},{step:'remaining',run:next}],10);
   const checked=expect(promise).rejects.toMatchObject({results:[{step:'blocked',status:'FAIL',timed_out:true},{step:'remaining',status:'PASS'}]});
   await vi.advanceTimersByTimeAsync(11);await checked;expect(next).toHaveBeenCalledOnce();
  }finally{vi.useRealTimers();}
 });
 it('never continues capacity on process failure, cleanup failure or stale evidence',()=>{
  const now=Date.now(),report={status:'PASS',cleanup:'PASS',source_sha256:'source',revision:'revision',generated_at:new Date(now).toISOString()};
  expect(capacityEvidenceValid(0,report,'source','revision',now-1)).toBe(true);
  expect(capacityEvidenceValid(1,report,'source','revision',now-1)).toBe(false);
  expect(capacityEvidenceValid(0,{...report,cleanup:'FAIL'},'source','revision',now-1)).toBe(false);
  expect(capacityEvidenceValid(0,{...report,cleanup:undefined},'source','revision',now-1)).toBe(false);
  expect(capacityEvidenceValid(0,report,'changed-source','revision',now-1)).toBe(false);
  expect(capacityEvidenceValid(0,report,'source','revision',now+1)).toBe(false);
 });
});
