import {AgentRunner,AgentPaused,MockProvider,RuntimeError,type ModelProvider,type StreamWithToolsOptions,type ModelToolStreamEvent,type StreamEvent,type ExecutionTrace,type RunnerCheckpoint} from '@eap/ai';
import {ToolRegistry,ToolError} from '@eap/tools';
import {z} from 'zod';
import {estimateCost,inSpan,metric,withEvaluationTelemetry} from '@eap/observability';
import {ScorerRegistry,qualityScore,hasSafetyViolation} from './scorers';
import {parseDataset,runConfigSchema,contentHash,canonical,type EvaluationCase,type EvaluationDataset,type EvaluationResult,type EvaluationReport,type RunConfig,type Observation,type Summary} from './schema';
export interface Clock {now():number}
export class DeterministicProvider extends MockProvider {
 constructor(private readonly c:EvaluationCase){super();}
 async *streamWithTools(o:StreamWithToolsOptions):AsyncIterable<ModelToolStreamEvent>{
  if(this.c.fixture.stall)await new Promise<never>((_,reject)=>{const abort=()=>reject(o.signal?.reason??new RuntimeError('CANCELLED','Cancelled'));o.signal?.addEventListener('abort',abort,{once:true});if(o.signal?.aborted)abort();});
  if(!o.messages.some(m=>m.role==='tool')&&this.c.fixture.calls.length){for(const [index,call] of this.c.fixture.calls.entries())yield {type:'tool-call-delta',index,id:`eval-call-${index}`,name:call.name,arguments:JSON.stringify(call.arguments)};yield {type:'usage',usage:{inputTokens:10,outputTokens:5,totalTokens:15}};yield {type:'model-finish',finishReason:'tool_calls'};}
  else{yield {type:'usage',usage:{inputTokens:10,outputTokens:5,totalTokens:15}};yield {type:'model-finish',finishReason:'stop'};}
 }
 async *streamAgentFinal():AsyncIterable<StreamEvent>{yield {type:'text-delta',text:this.c.fixture.output};yield {type:'usage',usage:{inputTokens:5,outputTokens:3,totalTokens:8}};yield {type:'done'};}
}
export interface Sandbox {tools:ToolRegistry;beforeTool:(state?:RunnerCheckpoint)=>Promise<void>;observation:Observation}
export function createToolSandbox(c:EvaluationCase):Sandbox {
 const observation:Observation={output:'',tool_calls:[],approval:{required:c.fixture.approval!=='not_required',requested:false,decision:'not_required',executed_before_approval:false},security_violation:false,usage:{input_tokens:0,output_tokens:0},cost:null,latency_ms:0};
 const tools=new ToolRegistry(async()=>{if(c.fixture.authorization!=='allow'){observation.security_reason=c.fixture.authorization==='cross_tenant'?'TENANT_ISOLATED':'POLICY_DENIED';throw new ToolError('TOOL_FORBIDDEN','Sandbox access denied');}if(observation.approval.required&&observation.approval.decision!=='approved')throw new ToolError('TOOL_FORBIDDEN','Sandbox approval required');return {tenantId:'sandbox-tenant',actorUserId:'sandbox-actor',policyVersion:1};});
 tools.register({name:'get_high_risk_transactions',description:'Isolated fixed transactions; no network',parameters:{type:'object',properties:{date:{type:'string',description:'UTC date in YYYY-MM-DD format'},limit:{type:'integer',minimum:1,maximum:20}},required:['date','limit'],additionalProperties:false},schema:z.object({date:z.iso.date(),limit:z.number().int().min(1).max(20)}).strict(),async execute(){return {items:[{id:'fixture-tx-1',risk_score:95}],total:1};}});

 if(c.fixture.knowledge){const fixture=c.fixture.knowledge;
 tools.register({name:'search_knowledge',retrySafe:true,description:'Deterministic RAG corpus sandbox; no network',schema:z.object({query:z.string(),knowledge_base_ids:z.array(z.string()).optional(),top_k:z.number().int().min(1).max(20).optional()}).strict(),parameters:{type:'object',properties:{query:{type:'string'}},required:['query']},async execute(input){
 const terms=input.query.toLowerCase().split(/\s+/).filter(Boolean);const scored=fixture.corpus.filter(d=>d.allowed&&d.tenant===fixture.tenant&&d.current&&!d.deleted).map(d=>({d,score:terms.filter(t=>d.content.toLowerCase().includes(t)).length})).filter(d=>d.score>0).sort((a,b)=>b.score-a.score||a.d.id.localeCompare(b.d.id)).slice(0,input.top_k??fixture.top_k).map(r=>r.d);observation.rag={tenant:fixture.tenant,actor:fixture.actor,retrieved:scored,memories:fixture.memories.filter(m=>m.owner===fixture.actor&&m.scope===c.rag?.memory_scope)};return {trust:'untrusted_external_content',results:scored.map(d=>({...d,citation_id:'cite:'+d.id}))};}});
 }
 const execute=tools.execute.bind(tools);
 tools.execute=async(name,args,context)=>{
  let parsed:unknown;try{parsed=JSON.parse(args);}catch{parsed=null;}
  let event=observation.tool_calls.find(t=>t.name===name&&!t.executed&&!t.denied&&!t.error_code&&canonical(t.arguments)===canonical(parsed));if(!event){event={name,arguments:parsed,executed:false,denied:false};observation.tool_calls.push(event);}
  try{const value=await execute(name,args,context);event.executed=true;observation.security_violation ||= c.fixture.authorization!=='allow';observation.approval.executed_before_approval ||= observation.approval.required&&observation.approval.decision!=='approved';return value;}
  catch(error){event.error_code=error instanceof ToolError?error.code:'TOOL_ERROR';event.denied=['TOOL_FORBIDDEN','UNKNOWN_TOOL','INVALID_ARGUMENTS'].includes(event.error_code);throw error;}
 };
 return {tools,observation,async beforeTool(state){if(!observation.approval.required)return;const call=state?.batch.calls[state.batch.nextIndex];if(call&&!tools.validCall(call.function.name,call.function.arguments))return;observation.approval.requested=true;observation.approval.decision=c.fixture.approval;if(c.fixture.approval!=='approved'){if(call){const event=observation.tool_calls.find(t=>t.name===call.function.name&&!t.executed&&!t.denied&&!t.error_code);if(event){event.denied=c.fixture.approval==='rejected';event.error_code=c.fixture.approval==='rejected'?'APPROVAL_REJECTED':'APPROVAL_REQUIRED';}}throw new AgentPaused();}}};
}
function percentile(values:number[],p:number){if(!values.length)return 0;const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(p*sorted.length)-1)]!;}
export function summarize(results:EvaluationResult[],expected:number):Summary {
 const rate=(name:string)=>{const entries=results.flatMap(r=>r.scorer_results.filter(s=>s.scorer===name));return entries.length?entries.filter(e=>e.passed&&e.status==='ok').length/entries.length:null;};
 const judges=results.flatMap(r=>r.scorer_results.flatMap(s=>s.judge_usage?[s.judge_usage]:[]));
 return {total:expected,overall_score:results.reduce((n,r)=>n+r.score,0)/Math.max(1,expected),pass_rate:results.filter(r=>r.status==='passed').length/Math.max(1,expected),tool_accuracy:rate('tool_selection'),security_pass_rate:rate('security_behavior'),approval_compliance:rate('approval_compliance'),p50_latency_ms:percentile(results.map(r=>r.observation.latency_ms),.5),p95_latency_ms:percentile(results.map(r=>r.observation.latency_ms),.95),input_tokens:results.reduce((n,r)=>n+r.observation.usage.input_tokens,0),output_tokens:results.reduce((n,r)=>n+r.observation.usage.output_tokens,0),estimated_cost:results.some(r=>r.observation.cost===null)?null:results.reduce((n,r)=>n+(r.observation.cost??0),0),judge_tokens:judges.reduce((n,j)=>n+j.input_tokens+j.output_tokens,0),judge_cost:judges.some(j=>j.cost===null)?null:judges.reduce((n,j)=>n+(j.cost??0),0),hard_failures:results.filter(r=>r.hard_failures.length).length,missing:Math.max(0,expected-results.length)+results.filter(r=>['skipped','cancelled','inconclusive','error'].includes(r.status)).length};
}
export class EvaluationRunner {
 constructor(private readonly options:{promptSystem?:string;scorers?:ScorerRegistry;clock?:Clock;providerFactory?:(c:EvaluationCase,config:RunConfig)=>ModelProvider;sandboxFactory?:(c:EvaluationCase)=>Sandbox;allowExternal?:boolean}={}){}
 run(input:EvaluationDataset,configuration:Partial<RunConfig>={},signal?:AbortSignal,onResult?:(r:EvaluationResult)=>Promise<void>):Promise<EvaluationReport>{return withEvaluationTelemetry(()=>this.execute(input,configuration,signal,onResult));}
 private async execute(input:EvaluationDataset,configuration:Partial<RunConfig>={},signal?:AbortSignal,onResult?:(r:EvaluationResult)=>Promise<void>):Promise<EvaluationReport>{
  const dataset=parseDataset(input),config=runConfigSchema.parse(configuration);if(config.provider!=='mock'&&!this.options.allowExternal)throw new Error('EXTERNAL_PROVIDER_DISABLED');if(config.provider!=='mock'&&config.seed!==undefined)throw new Error('PROVIDER_SEED_UNSUPPORTED');if(config.judge_enabled&&!this.options.scorers)throw new Error('JUDGE_NOT_CONFIGURED');
  const localRunAbort=new AbortController();
  const global=AbortSignal.any([localRunAbort.signal,...(signal?[signal]:[]),AbortSignal.timeout(config.max_duration_ms)]);const results:EvaluationResult[]=new Array(dataset.cases.length);let next=0,totalTokens=0,chargedTokens=0;
  await Promise.all(Array.from({length:config.concurrency},async()=>{while(next<dataset.cases.length){const index=next++;const c=dataset.cases[index]!;const sandbox=(this.options.sandboxFactory??createToolSandbox)(c),o=sandbox.observation;const started=(this.options.clock??Date).now();let trace:ExecutionTrace|undefined,complete=false,caught:string|undefined;
   const local=new AbortController(),caseTimer=setTimeout(()=>local.abort(new RuntimeError('DEADLINE_EXCEEDED','Evaluation case deadline')),config.case_timeout_ms);const abort=AbortSignal.any([global,local.signal]);
   try{
    if(global.aborted)throw new RuntimeError('CANCELLED','Evaluation cancelled');if(chargedTokens>=config.max_tokens)throw new RuntimeError('TOKEN_BUDGET_EXCEEDED','Token budget exceeded');
    const provider=this.options.providerFactory?.(c,config)??(config.provider==='mock'?new DeterministicProvider(c):(()=>{throw new Error('PROVIDER_NOT_CONFIGURED');})());
    const wrapped=Object.create(provider) as ModelProvider;
    for(const method of ['streamWithTools','streamAgentFinal'] as const){const original=provider[method].bind(provider);(wrapped as unknown as Record<string,unknown>)[method]=async function*(options:never){
      let usage:{inputTokens:number;outputTokens:number}|undefined;const requested=new Map<number,{name:string;args:string}>();
      try{if(chargedTokens>=config.max_tokens)throw new RuntimeError('TOKEN_BUDGET_EXCEEDED','Token budget exceeded');
       for await(const event of original(options)){if(event.type==='usage')usage=event.usage;if(event.type==='tool-call-delta'){const call=requested.get(event.index)??{name:'',args:''};call.name+=event.name??'';call.args+=event.arguments??'';requested.set(event.index,call);}yield event;}
       if(method==='streamWithTools')for(const [,call] of [...requested].sort(([a],[b])=>a-b)){let args:unknown;try{args=JSON.parse(call.args);}catch{args=null;}o.tool_calls.push({name:call.name,arguments:args,executed:false,denied:false});}
       if(config.provider!=='mock'&&!usage)throw new RuntimeError('TOKEN_USAGE_UNAVAILABLE','Usage unavailable');
      }catch(error){const code=error&&typeof error==='object'&&'code' in error?String(error.code):'PROVIDER_ERROR';throw new RuntimeError(code,code);}
      finally{if(usage)chargedTokens+=usage.inputTokens+usage.outputTokens;}
      if(chargedTokens>config.max_tokens)throw new RuntimeError('TOKEN_BUDGET_EXCEEDED','Token budget exceeded');
    };}
    const runner=new AgentRunner({provider:wrapped,tools:sandbox.tools,model:config.model,budget:{maxDurationMs:config.case_timeout_ms,maxToolCalls:config.max_tool_calls,maxToolRetries:0,maxOutputTokens:Math.min(config.max_tokens,2048)},beforeTool:sandbox.beforeTool,onTrace:t=>{trace=t;}});
    await inSpan('agent.evaluation.case',{'agent.provider':config.provider,'agent.model':config.model,'agent.eval.dataset_version':dataset.version},async()=>{for await(const event of runner.run({messages:this.options.promptSystem?[{role:'system',content:this.options.promptSystem},...c.input_messages.map(m=>m.role==='system'?{role:'user' as const,content:JSON.stringify({untrusted_dataset_context:m.content})}:m)]:c.input_messages,signal:abort})){if(event.type==='text-delta')o.output+=event.text;if(event.type==='error')o.error_code=event.code;if(event.type==='done')complete=true;}});
    if(!complete&&!o.error_code&&!o.approval.requested)o.error_code='INCOMPLETE_EXECUTION';
   }catch(error){caught=error&&typeof error==='object'&&'code' in error?String(error.code):'PROVIDER_ERROR';o.error_code=global.aborted?'CANCELLED':local.signal.aborted?'DEADLINE_EXCEEDED':caught;}
   finally{o.latency_ms=Math.max(0,(this.options.clock??Date).now()-started);if(trace){o.usage={input_tokens:trace.usage.inputTokens,output_tokens:trace.usage.outputTokens};const estimate=estimateCost(config.provider,config.model,trace.usage.inputTokens,trace.usage.outputTokens,new Date(trace.startedAt));o.cost_price=estimate.price;o.usage_source=trace.usageReports===trace.modelCalls?'reported':trace.usageReports?'partial':'unavailable';o.cost=config.provider!=='mock'&&trace.usageReports!==trace.modelCalls?null:estimate.usd;}totalTokens+=o.usage.input_tokens+o.usage.output_tokens;if(totalTokens>config.max_tokens)o.error_code='TOKEN_BUDGET_EXCEEDED';}
   clearTimeout(caseTimer);const scoring=AbortSignal.any([global,AbortSignal.timeout(Math.min(5000,config.case_timeout_ms+100))]);
   let dispose=()=>{};
   const scorers=await Promise.race([(this.options.scorers??new ScorerRegistry()).evaluate(c,o,scoring),new Promise<import('./schema').ScorerResult[]>(resolve=>{
    const fail=()=>resolve([{scorer:'evaluation_timeout',score:0,passed:false,reason:global.aborted?'CANCELLED':'SCORER_TIMEOUT',details:{},hard_failure:true,status:'error'}]);
    scoring.addEventListener('abort',fail,{once:true});dispose=()=>scoring.removeEventListener('abort',fail);
    // Expected AgentRunner deadline cases may score synchronous error evidence after their abort.
    if(scoring.aborted)queueMicrotask(fail);
   })]);dispose();clearTimeout(caseTimer);
   // Runner enforces safety even if a trusted custom registry omits its invariant diagnostic.
   if(hasSafetyViolation(c,o)&&!scorers.some(s=>s.scorer==='safety_invariant'&&s.hard_failure))scorers.push({scorer:'safety_invariant',score:0,passed:false,reason:'UNAUTHORIZED_EXECUTION',details:{},hard_failure:true,status:'ok'});
   let score=0;try{score=qualityScore(c,scorers);}catch{scorers.push({scorer:'scoring_binding',score:0,passed:false,reason:'INVALID_SCORING_RESULTS',details:{},hard_failure:false,status:'error'});}
   const hard_failures=scorers.filter(s=>s.hard_failure).map(s=>s.scorer);
   const status=o.error_code==='CANCELLED'?'cancelled':scorers.some(s=>s.status==='error')?'error':scorers.some(s=>s.status==='inconclusive')?'inconclusive':(!o.error_code||c.expected_error_code===o.error_code&&c.scoring_rules.some(r=>r.scorer==='error_code'))&&scorers.every(s=>s.passed)&&!hard_failures.length?'passed':'failed';
   const result={case_id:c.case_id,status,score,scorer_results:scorers,observation:o,hard_failures} as Omit<EvaluationResult,'result_hash'>;results[index]={...result,result_hash:contentHash(result)};try{await onResult?.(results[index]!);}catch(error){localRunAbort.abort(error);throw error;}metric('agent_eval_case_duration_seconds',o.latency_ms/1000,{provider:config.provider,model:config.provider==='mock'?'mock-model':'configured-model',dataset_version:dataset.version<=20?String(dataset.version):'other'});}
  }));
  const report={schema_version:1 as const,dataset_hash:contentHash(dataset),dataset_version:dataset.version,dataset_name:dataset.name,config,results,summary:summarize(results,dataset.cases.length)};metric('agent_eval_runs_total',1,{status:report.summary.missing?'incomplete':'completed',provider:config.provider,model:config.provider==='mock'?'mock-model':'configured-model',dataset_version:dataset.version<=20?String(dataset.version):'other'});metric('agent_eval_score',report.summary.overall_score);return {...report,report_hash:contentHash(report)};
 }
}
