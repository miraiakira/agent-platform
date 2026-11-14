import {spawn, type ChildProcess} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {createConnection} from 'node:net';
import {safeError, type SafeError} from './diagnostics';

export interface ProcessRecord {
 service:string; command:string; args:string[]; pid?:number; process_group?:number;
 started_at:string; exited_at?:string; exit_code?:number|null; signal?:string|null;
 spawn_error?:SafeError; log_error?:SafeError; stop_error?:SafeError; sigkill_used?:boolean; group_gone?:boolean;
}
const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
export class FixtureProcesses {
 readonly records:ProcessRecord[]=[];
 readonly children:ChildProcess[]=[];
 start(service:string,command:string,args:string[],cwd:string,env:NodeJS.ProcessEnv,logFile:string){
  const record:ProcessRecord={service,command,args,started_at:new Date().toISOString()};
  const child=spawn(command,args,{cwd,env,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
  record.pid=child.pid;if(process.platform!=='win32')record.process_group=child.pid;
  this.records.push(record);this.children.push(child);
  const stream=createWriteStream(logFile,{mode:0o600});
  stream.on('error',error=>{record.log_error=safeError(error);});
  child.stdout!.pipe(stream,{end:false});child.stderr!.pipe(stream,{end:false});
  child.once('error',error=>{record.spawn_error=safeError(error);stream.end();});
  child.once('close',(code,signal)=>{record.exit_code=code;record.signal=signal;record.exited_at=new Date().toISOString();stream.end();});
  return child;
 }
 healthy(){return this.children.every((child,i)=>!this.records[i]!.spawn_error&&!this.records[i]!.log_error&&child.exitCode===null&&child.signalCode===null);}
 forceStop(){
  for(const [index,record] of this.records.entries())try{
   if(this.alive(index)){if(record.process_group)process.kill(-record.process_group,'SIGKILL');else this.children[index]!.kill('SIGKILL');}
  }catch{/* Exit fallback cannot certify cleanup; ordinary finally records failures. */}
 }
 private alive(index:number):boolean{
  const child=this.children[index]!,record=this.records[index]!;
  if(!record.pid)return false;
  if(process.platform==='win32')return child.exitCode===null&&child.signalCode===null;
  try{process.kill(-record.pid,0);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return false;throw error;}
 }
 async stop(index:number){
  const child=this.children[index]!,record=this.records[index]!;
  const send=(signal:NodeJS.Signals)=>{try{if(record.process_group)process.kill(-record.process_group,signal);else child.kill(signal);}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}};
  try{
   if(this.alive(index))send('SIGTERM');
   const until=Date.now()+3000;
   while(this.alive(index)&&Date.now()<until)await delay(100);
   if(this.alive(index)){record.sigkill_used=true;send('SIGKILL');}
   const killedUntil=Date.now()+1000;
   while(this.alive(index)&&Date.now()<killedUntil)await delay(100);
   record.group_gone=!this.alive(index);
   if(!record.group_gone)throw Object.assign(new Error('Fixture process group remains'),{code:'PROCESS_GROUP_REMAINS'});
   if(record.log_error)throw Object.assign(new Error('Fixture log unavailable'),{code:'FIXTURE_LOG_FAILED'});
  }catch(error){record.stop_error=safeError(error);throw error;}
 }
}
export async function portState(port:number):Promise<{port:number;state:'LISTENING'|'CLOSED'|'UNKNOWN';error?:SafeError}>{
 return new Promise(resolve=>{
  const socket=createConnection({host:'127.0.0.1',port});
  let settled=false;
  const finish=(state:'LISTENING'|'CLOSED'|'UNKNOWN',error?:unknown)=>{if(settled)return;settled=true;socket.destroy();resolve({port,state,...(error?{error:safeError(error)}:{})});};
  socket.setTimeout(300,()=>finish('UNKNOWN',Object.assign(new Error('Port probe timeout'),{code:'PORT_PROBE_TIMEOUT'})));
  socket.once('connect',()=>finish('LISTENING'));
  socket.once('error',error=>finish((error as NodeJS.ErrnoException).code==='ECONNREFUSED'?'CLOSED':'UNKNOWN',error));
 });
}
