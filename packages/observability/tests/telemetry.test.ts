import { afterEach, describe, expect, it, vi } from "vitest";
import { trace } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { InMemoryMetricExporter, PeriodicExportingMetricReader, AggregationTemporality } from "@opentelemetry/sdk-metrics";
import { initTelemetry, shutdownTelemetry, startSpan, injectTraceHeaders, extractTraceContext, inSpan, log, metric,
  observeModelStream, estimateCost, loadPrices, observeOperation, withIdentity } from "../src";

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
