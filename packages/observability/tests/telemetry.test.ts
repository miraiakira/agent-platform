import { afterEach, describe, expect, it, vi } from "vitest";
import { trace } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { InMemoryMetricExporter, PeriodicExportingMetricReader, AggregationTemporality } from "@opentelemetry/sdk-metrics";
import { initTelemetry, shutdownTelemetry, startSpan, injectTraceHeaders, extractTraceContext, inSpan, log, metric,
  observeModelStream, estimateCost, loadPrices, observeOperation, withIdentity, withEvaluationTelemetry, getTelemetryState } from "../src";

afterEach(async () => { await shutdownTelemetry(); vi.unstubAllEnvs(); });
function setup(sink = (_line:string) => {}) {
 const spans = new InMemorySpanExporter();
 const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
 const reader = new PeriodicExportingMetricReader({ exporter: metrics, exportIntervalMillis: 60_000 });
 initTelemetry({ service: "test", enabled: true, spanExporter: spans, metricReader: reader, sink });
 return { spans, metrics, reader };
}
describe("observability contract", () => {
 it("propagates only W3C traceparent across a detached job context", async () => {
  const {spans} = setup(); let headers: Record<string,string> = {};
  await inSpan("agent.job.submit",{}, async () => { headers = injectTraceHeaders(); });
  await inSpan("agent.run",{}, async () => {}, extractTraceContext({...headers, baggage:"secret=not-propagated"}));
  const finished = spans.getFinishedSpans();
  expect(finished[1].spanContext().traceId).toBe(finished[0].spanContext().traceId);
  expect(finished[1].parentSpanContext?.spanId).toBe(finished[0].spanContext().spanId);
  expect(Object.keys(headers)).toEqual(["traceparent"]);
 });
 it("initializes once and drops sensitive span attributes", () => {
  const {spans} = setup();
  initTelemetry({service:"duplicate",enabled:true,spanExporter:new InMemorySpanExporter()});
  startSpan("test",{"agent.run_id":"run",prompt:"secret",Authorization:"Bearer sk-private",tool_result:"sensitive"}).end();
  expect(spans.getFinishedSpans()).toHaveLength(1);
  expect(spans.getFinishedSpans()[0].attributes).toEqual({"agent.run_id":"run","agent.status":"completed"});
 });
 it("correlates JSON logs and uses a strict allowlist with failure isolation", async () => {
  const lines:string[]=[]; setup((line) => { lines.push(line); });
  await inSpan("agent.run",{},async () => {
   withIdentity({run_id:"run-1"},() => log("info","job.finished",{ ...{api_key:"sk-secret",prompt:"secret"},job_id:"job-1" }));
   log("error","Bearer sk-secret",{ worker_id:"sk-private" });
  });
  expect(JSON.parse(lines[0])).toMatchObject({run_id:"run-1",job_id:"job-1",message:"job.finished"});
  expect(JSON.parse(lines[0]).trace_id).toMatch(/^[a-f0-9]{32}$/);
  expect(lines.join()).not.toContain("secret"); expect(lines.join()).not.toContain("private");
 });
 it("does not fail when a log sink throws", async () => { setup(()=>{throw new Error("disk failed")}); expect(()=>log("info","test.event")).not.toThrow(); });
 it("records approval counters, seconds histogram and an absolute pending gauge without IDs",async()=>{
  const {reader,metrics}=setup();
  metric('agent_approvals_requested_total',1,{approval_id:'must-not-appear',run_id:'never'});
  metric('agent_approvals_decided_total',1,{status:'approved',user_id:'never'});
  metric('agent_approval_wait_duration_seconds',2);
  metric('agent_approvals_pending',3);metric('agent_approvals_pending',1);
  await reader.forceFlush();const data=metrics.getMetrics().flatMap(r=>r.scopeMetrics.flatMap(s=>s.metrics));
  expect(data.find(m=>m.descriptor.name==='agent_approvals_pending')?.dataPoints[0].value).toBe(1);
  expect(data.find(m=>m.descriptor.name==='agent_approval_wait_duration_seconds')?.descriptor.unit).toBe('s');
  expect(data.find(m=>m.descriptor.name==='agent_approvals_requested_total')?.descriptor.unit).toBe('1');
  expect(JSON.stringify(data)).not.toContain('must-not-appear');expect(JSON.stringify(data)).not.toContain('never');
 });
 it("records bounded evaluation metrics without Eval Run or User labels",async()=>{
  const {reader,metrics}=setup();withEvaluationTelemetry(()=>{metric('agent_runs_total',1);metric('agent_model_tokens_total',999);});metric('agent_eval_runs_total',1,{provider:'mock',model:'mock-model',dataset_version:'1',eval_run_id:'private-eval',user_id:'private-user'});metric('agent_eval_case_duration_seconds',.02);metric('agent_eval_score',.8);metric('agent_eval_regressions_total',1);metric('agent_eval_gate_failures_total',1);await reader.forceFlush();
  const data=metrics.getMetrics().flatMap(r=>r.scopeMetrics.flatMap(s=>s.metrics));expect(data.find(m=>m.descriptor.name==='agent_eval_score')?.dataPoints[0].value).toBe(.8);expect(data.find(m=>m.descriptor.name==='agent_eval_case_duration_seconds')?.descriptor.unit).toBe('s');expect(JSON.stringify(data)).not.toContain('private-eval');expect(JSON.stringify(data)).not.toContain('private-user');expect(data.some(m=>m.descriptor.name==='agent_runs_total'||m.descriptor.name==='agent_model_tokens_total')).toBe(false);
 });
 it("records model usage only once per request and rejects high-cardinality labels", async () => {
  const {reader,metrics} = setup();
  for await (const _event of observeModelStream(async function*(){
   yield {type:"usage",usage:{inputTokens:10,outputTokens:5}};
   yield {type:"usage",usage:{inputTokens:10,outputTokens:5}};
  },{"agent.provider":"mock","agent.model":"mock-model"})) { void _event; }
  metric("agent_worker_active_jobs",1,{run_id:"never-a-label"});
  metric("agent_worker_active_jobs",-1);
  await reader.forceFlush();
  const data=metrics.getMetrics().flatMap((m)=>m.scopeMetrics.flatMap((s)=>s.metrics));
  const tokens=data.find((m)=>m.descriptor.name==="agent_model_tokens_total")!;
  expect(tokens.dataPoints.map((p)=>p.value)).toEqual([10,5]);
  expect(JSON.stringify(data)).not.toContain("never-a-label");
  const histogram = data.find((m)=>m.descriptor.name==="agent_model_duration_seconds")!;
  expect(histogram.dataPoints).toHaveLength(1);
  expect(histogram.dataPoints[0].value).toMatchObject({ count: 1 });
  expect(data.find((m)=>m.descriptor.name==="agent_worker_active_jobs")?.dataPoints[0].value).toBe(0);
 });
 it("records the last cumulative Usage only after normal stream exhaustion",async()=>{
  vi.stubEnv("MODEL_PRICES_JSON",JSON.stringify([{provider:"mock",model:"mock-model",input:2,output:4,unit:"per_million_tokens",effectiveAt:"2020-01-01",version:"test-v1"}]));
  const {reader,metrics}=setup();
  const stream=observeModelStream(async function*(){
    yield {type:"usage",usage:{inputTokens:10,outputTokens:5}};
    yield {type:"usage",usage:{inputTokens:30,outputTokens:12}};
  },{"agent.provider":"mock","agent.model":"mock-model"});
  const tokens=()=>metrics.getMetrics().flatMap((r)=>r.scopeMetrics.flatMap((s)=>s.metrics)).find((m)=>m.descriptor.name==="agent_model_tokens_total");
  await stream.next();await reader.forceFlush();expect(tokens()).toBeUndefined();
  await stream.next();await reader.forceFlush();expect(tokens()).toBeUndefined();
  expect((await stream.next()).done).toBe(true);
  await reader.forceFlush();expect(tokens()?.dataPoints.map((p)=>p.value)).toEqual([30,12]);
  const cost=metrics.getMetrics().flatMap((r)=>r.scopeMetrics.flatMap((s)=>s.metrics)).find((m)=>m.descriptor.name==="agent_model_estimated_cost_usd_total")!;
  expect(cost.dataPoints).toHaveLength(1);expect(cost.dataPoints[0].value).toBeCloseTo(0.000108,12);
 });
 it("does not commit preliminary Usage when the source throws, and rethrows the exact error",async()=>{
  const {reader,metrics,spans}=setup();const error=new Error("business stream failure");
  const consume=async()=>{for await(const event of observeModelStream(async function*(){
    yield {type:"usage",usage:{inputTokens:10,outputTokens:5}};throw error;
  },{})) void event;};
  await expect(consume()).rejects.toBe(error);
  await reader.forceFlush();
  expect(metrics.getMetrics().flatMap((r)=>r.scopeMetrics.flatMap((s)=>s.metrics)).some((m)=>m.descriptor.name==="agent_model_tokens_total")).toBe(false);
  expect(spans.getFinishedSpans()[0].status.code).toBe(2);
 });
 it.each(["error-event","invalid-final","consumer-return"])("does not count unconfirmed Usage: %s",async(mode)=>{
  const {reader,metrics}=setup();
  const stream=observeModelStream(async function*(){
    yield {type:"usage",usage:{inputTokens:10,outputTokens:5}};
    if(mode==="error-event") yield {type:"error",code:"PROVIDER_ERROR"};
    if(mode==="invalid-final") yield {type:"usage",usage:{inputTokens:-1,outputTokens:NaN}};
  },{});
  if(mode==="consumer-return"){await stream.next();await stream.return(undefined);}
  else for await(const event of stream) void event;
  await reader.forceFlush();
  expect(metrics.getMetrics().flatMap((r)=>r.scopeMetrics.flatMap((s)=>s.metrics)).some((m)=>m.descriptor.name==="agent_model_tokens_total")).toBe(false);
 });
 it("records and preserves synchronous factory errors",async()=>{
  const {spans}=setup();const error=new Error("provider factory failed");
  const consume=async()=>{for await(const event of observeModelStream(()=>{throw error},{})) void event};
  await expect(consume()).rejects.toBe(error);
  expect(spans.getFinishedSpans()).toHaveLength(1);expect(spans.getFinishedSpans()[0].status.code).toBe(2);
 });
 it("ignores a telemetry classifier failure without changing business outcomes",async()=>{
  setup();const classifier=()=>{throw new Error("telemetry classifier failed")};
  expect(await observeOperation("tool",{},async()=>42,classifier)).toBe(42);
  expect(await inSpan("business",{},async()=>42,undefined,classifier)).toBe(42);
  const error=new Error("real business failure");
  await expect(observeOperation("tool",{},async()=>{throw error})).rejects.toBe(error);
  Object.defineProperty(error,"code",{get(){throw new Error("metadata access failed")}});
  await expect(inSpan("business",{},async()=>{throw error})).rejects.toBe(error);
  await expect(observeOperation("tool",{},async()=>{throw error})).rejects.toBe(error);
 });
 it("assigns explicit compatible units to counters, histograms and active work",async()=>{
  const {reader,metrics}=setup();
  metric("agent_runs_total",1);metric("agent_run_duration_seconds",2);
  metric("agent_model_estimated_cost_usd_total",0.5);
  metric("agent_active_runs",1);metric("agent_active_runs",-1);
  metric("agent_worker_active_jobs",1);metric("agent_worker_active_jobs",-1);
  await reader.forceFlush();
  const descriptors=Object.fromEntries(metrics.getMetrics().flatMap((r)=>r.scopeMetrics.flatMap((s)=>s.metrics)).map((m)=>[m.descriptor.name,m.descriptor.unit]));
  expect(descriptors).toEqual({agent_runs_total:"1",agent_run_duration_seconds:"s",agent_model_estimated_cost_usd_total:"USD",agent_active_runs:"1",agent_worker_active_jobs:"1"});
 });
 it.each(["DEADLINE_EXCEEDED","CANCELLED","LEASE_LOST"])("sets error status without exporting exception content: %s",async(code)=>{
  const {spans}=setup();
  await expect(inSpan("agent.run",{},async()=>{throw Object.assign(new Error("secret payload"),{code})})).rejects.toThrow();
  const span=spans.getFinishedSpans()[0];
  expect(span.status.code).toBe(2);expect(span.attributes["agent.error_code"]).toBe(code);
  expect(span.events).toEqual([]);
 });
 it("calls a tool exactly once when the span exporter and log sink fail",async()=>{
  const exported=vi.fn();
  initTelemetry({service:"failing-export",enabled:true,sink:()=>{throw new Error("broken sink")},
    spanExporter:{export(_spans,callback){exported();callback({code:1,error:new Error("collector unavailable")})},shutdown:async()=>{}},
    metricReader:new PeriodicExportingMetricReader({exporter:new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),exportIntervalMillis:60_000}),
  });
  const execute=vi.fn(async()=>{log("info","tool.executed");return "ok"});
  expect(await observeOperation("tool",{"agent.tool.name":"read"},execute)).toBe("ok");
  expect(execute).toHaveBeenCalledOnce();expect(exported).toHaveBeenCalledOnce();
 });
 it("bounds shutdown while collector is unreachable",async()=>{
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT","http://127.0.0.1:1");
  initTelemetry({service:"failure-test",enabled:true,sink:()=>{}});
  startSpan("agent.run").end();metric("agent_runs_total",1);
  const started=Date.now(); await shutdownTelemetry(50);
  expect(Date.now()-started).toBeLessThan(1500);
  // Wait for the bounded built-in exporters to actually retire before the next fixture.
  await shutdownTelemetry(3000);
  expect(getTelemetryState().cleanupPending).toBe(false);
 });
 it("keeps SDK disabled even when another framework registered a global exporter",async()=>{
  const spans = new InMemorySpanExporter();
  const framework = new NodeTracerProvider({spanProcessors:[new SimpleSpanProcessor(spans)]});
  trace.setGlobalTracerProvider(framework);
  try {
    initTelemetry({service:"disabled",enabled:false});
    expect(()=>startSpan("agent.run").end()).not.toThrow();
    expect(spans.getFinishedSpans()).toHaveLength(0);
  } finally { trace.disable(); await framework.shutdown(); }
 });
 it("computes versioned effective prices and preserves unknown cost",()=>{
  const price={provider:"test",model:"model",input:2,output:4,unit:"per_million_tokens" as const,effectiveAt:"2026-01-01",version:"v1"};
  expect(estimateCost("test","model",1_000_000,500_000,new Date("2026-11-01"),[price]).usd).toBe(4);
  expect(estimateCost("test","missing",10,10,new Date(),[price]).usd).toBeNull();
  expect(estimateCost("test","model",10,10,new Date("2025-01-01"),[price]).usd).toBeNull();
  expect(loadPrices('{"input":-1}')).toEqual([]);
 });
});
