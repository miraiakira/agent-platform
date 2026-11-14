import {afterEach,describe,it,expect,vi} from 'vitest';
import {loadPersistedAgentChat,loadPersistedToolActivities} from './persisted-agent-chat';
const id='11111111-1111-4111-8111-111111111111';
const data={id,conversation_id:'conversation',status:'completed',input:[{role:'system',content:'private instructions'},{role:'user',content:'查询交易'},{role:'tool',content:'private result'}],output:{answer:'审批后原回答'}};
afterEach(()=>vi.unstubAllGlobals());
describe('restoring persisted Agent chat',()=>{
 it('replays committed tool events without re-executing a job or duplicating a tool',async()=>{
  const events=[{type:'tool-start',toolCallId:'call-1',toolName:'query'},{type:'tool-start',toolCallId:'call-1',toolName:'query'},
   {type:'tool-result',toolCallId:'call-1',toolName:'query',success:true,attempts:1},{type:'done'}];
  const fetcher=vi.fn().mockResolvedValue(new Response(events.map((e,i)=>`id: ${i+1}\ndata: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'Content-Type':'text/event-stream'}}));
  vi.stubGlobal('fetch',fetcher);const controller=new AbortController();
  expect(await loadPersistedToolActivities(id,controller.signal)).toEqual([{id:'call-1',name:'query',status:'success'}]);
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(`/api/agent/runs/${id}/events`,{headers:{'Last-Event-ID':'0'},signal:controller.signal});
 });
 it('preserves failed tools and marks an unfinished tool as uncertain on a terminal run',async()=>{
  const events=[{type:'tool-result',toolCallId:'failed',toolName:'query',success:false,attempts:1},
   {type:'tool-start',toolCallId:'unfinished',toolName:'query'},{type:'error',code:'WORKER_STOPPED',message:'Stopped'}];
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(events.map((e,i)=>`id: ${i+1}\ndata: ${JSON.stringify(e)}\n\n`).join(''))));
  expect(await loadPersistedToolActivities(id,new AbortController().signal)).toEqual([
   {id:'failed',name:'query',status:'error'},{id:'unfinished',name:'query',status:'interrupted'},
  ]);
 });
 it('loads original user messages and committed answer with GET only',async()=>{
  const fetcher=vi.fn().mockResolvedValue(Response.json({run:data}));vi.stubGlobal('fetch',fetcher);const controller=new AbortController();
  const result=await loadPersistedAgentChat(id,controller.signal);expect(result.messages).toEqual([{role:'user',content:'查询交易'}]);expect(result.answer).toBe('审批后原回答');
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(`/api/agent/runs/${id}`,{signal:controller.signal,cache:'no-store'});
 });
 it('restores a waiting run without synthesizing an answer or submitting another task',async()=>{
  const fetcher=vi.fn().mockResolvedValue(Response.json({run:{...data,status:'waiting_approval',output:null}}));vi.stubGlobal('fetch',fetcher);
  const result=await loadPersistedAgentChat(id,new AbortController().signal);expect(result.answer).toBe('');expect(result.run.status).toBe('waiting_approval');expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('preserves conversation context needed to continue an existing conversation',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({run:{...data,input:[{role:'user',content:'first'},{role:'assistant',content:'answer'},{role:'user',content:'second'}]}})));
  expect((await loadPersistedAgentChat(id,new AbortController().signal)).messages).toEqual([{role:'user',content:'first'},{role:'assistant',content:'answer'},{role:'user',content:'second'}]);
 });
 it('rejects inaccessible and mismatched runs without using cached chat text',async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(Response.json({error:'NOT_FOUND'},{status:404})).mockResolvedValueOnce(Response.json({run:{...data,id:'foreign'}}));vi.stubGlobal('fetch',fetcher);
  await expect(loadPersistedAgentChat(id,new AbortController().signal)).rejects.toThrow();await expect(loadPersistedAgentChat(id,new AbortController().signal)).rejects.toThrow('INVALID_RUN_DATA');
 });
 it('rejects invalid URL identifiers before making a request',async()=>{
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);await expect(loadPersistedAgentChat('../secrets',new AbortController().signal)).rejects.toThrow('INVALID_RUN_ID');expect(fetcher).not.toHaveBeenCalled();
 });
});
