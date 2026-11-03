import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { ROOT_CONTEXT, trace, ProxyTracerProvider, SpanStatusCode, SpanKind, type Context, type Attributes } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor, SimpleSpanProcessor, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { MeterProvider, PeriodicExportingMetricReader, type MetricReader } from "@opentelemetry/sdk-metrics";
import { LoggerProvider, BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { estimateCost } from "./cost";
export * from "./cost";

type Identity = { run_id?: string; job_id?: string; worker_id?: string; evaluation?: boolean };
export type TelemetryPhase = "idle" | "initializing" | "disabled" | "ready" | "failed" | "shutting-down";
type Sdk = { tracer: NodeTracerProvider; meter: MeterProvider; logs?: LoggerProvider };
type Cleanup = () => Promise<void>;
type Instrument = { add?: (v:number,a:Attributes) => void; record?: (v:number,a:Attributes)=>void };
type State = {
  service: string; sdk?: Sdk; phase: TelemetryPhase;
  manager: AsyncLocalStorageContextManager; identity: AsyncLocalStorage<Identity>;
  cleanup?: Promise<void>; cleanups: Cleanup[]; instruments: Map<string, Instrument>;
  initializationError?: "INITIALIZATION_FAILED" | "RESTART_REQUIRED" | "CLEANUP_FAILED"; sink: (line: string) => void;
};
const key = Symbol.for("eap.observability.v1");
const globals = globalThis as typeof globalThis & { [key]?: State };
const state: State = globals[key] ??= { service: "eap", manager: new AsyncLocalStorageContextManager().enable(),
  identity: new AsyncLocalStorage<Identity>(), phase: "idle", cleanups: [], instruments: new Map(), sink: (line) => { console.log(line); } };
// A hot reload from the old boolean-based implementation cannot prove that a
// timed-out legacy shutdown has really settled. Retire it and require a process
// restart rather than risking overlapping SDK generations.
if (!("phase" in state)) {
  const legacy = state as State & { tracer?: NodeTracerProvider; meter?: MeterProvider; logs?: LoggerProvider };
  Object.assign(state, { phase: "failed", cleanups: [], initializationError: "RESTART_REQUIRED",
    cleanup: new Promise<void>(() => {}) });
  for (const sdk of [legacy.tracer, legacy.meter, legacy.logs]) {
    if (sdk) void Promise.resolve().then(() => sdk.shutdown()).catch(() => {});
  }
}
state.instruments ??= new Map();
const propagator = new W3CTraceContextPropagator();
export function safe<T>(fn: () => T): T | undefined { try { return fn(); } catch { return undefined; } }
export function getTelemetryState() {
  return { phase: state.phase, cleanupPending: Boolean(state.cleanup), initializationError: state.initializationError };
}

// Keep the cleanup promise until the SDK has actually settled, not just until a caller's wait expires.
function cleanupResources(cleanups: Cleanup[], next: "idle" | "failed") {
  const cleanup = Promise.allSettled(cleanups.map((close) => Promise.resolve().then(close))).then((results) => {
    if (state.cleanup !== cleanup) return;
    state.cleanup = undefined;
    if (results.some((result) => result.status === "rejected")) {
      state.phase = "failed";
      state.initializationError = "CLEANUP_FAILED";
      return;
    }
    state.phase = next;
    if (next === "idle") state.initializationError = undefined;
  });
  state.cleanup = cleanup;
  return cleanup;
}

export function initTelemetry(options: { service: string; enabled?: boolean; spanExporter?: SpanExporter; metricReader?: MetricReader;
  sink?: (line: string) => void } ) {
  if (state.initializationError === "CLEANUP_FAILED" || state.cleanup || ["initializing", "ready", "disabled", "shutting-down"].includes(state.phase)) return getTelemetryState();
  state.phase = "initializing";
  state.initializationError = undefined;
  state.service = options.service;
  if (options.sink) state.sink = options.sink;
  if (!(options.enabled ?? process.env.OTEL_ENABLED === "true")) {
    state.phase = "disabled";
    return getTelemetryState();
  }
  const cleanups: Cleanup[] = [];
  // Transfer ownership from exporter -> processor/reader -> provider only after each constructor succeeds.
  function own(resource: { shutdown(): Promise<void> }, replaces?: number) {
    const close = () => resource.shutdown();
    if (replaces !== undefined) { cleanups[replaces] = close; return replaces; }
    return cleanups.push(close) - 1;
  }
  try {
    const resource = resourceFromAttributes({ "service.name": options.service, "service.version": "0.1.0", "service.instance.id": randomUUID(),
      "deployment.environment.name": process.env.NODE_ENV ?? "development" });
    const endpoint = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://127.0.0.1:4318").replace(/\/$/, "");
    const spanExporter = options.spanExporter ?? new OTLPTraceExporter({ url: `${endpoint}/v1/traces`, timeoutMillis: 1000 });
    const traceOwner = own(spanExporter);
    const processor = options.spanExporter ? new SimpleSpanProcessor(spanExporter)
      : new BatchSpanProcessor(spanExporter, { maxQueueSize: 1024, maxExportBatchSize: 128, scheduledDelayMillis: 1000, exportTimeoutMillis: 1500 });
    own(processor, traceOwner);
    const tracer = new NodeTracerProvider({ resource, spanProcessors: [processor] });
    own(tracer, traceOwner);

    let reader = options.metricReader;
    let meterOwner: number;
    if (reader) meterOwner = own(reader);
    else {
      const exporter = new OTLPMetricExporter({ url: `${endpoint}/v1/metrics`, timeoutMillis: 1000 });
      meterOwner = own(exporter);
      reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 5000, exportTimeoutMillis: 1500 });
      own(reader, meterOwner);
    }
    const meter = new MeterProvider({ resource, readers: [reader] });
    own(meter, meterOwner);

    let logs: LoggerProvider | undefined;
    if (!options.spanExporter) {
      const exporter = new OTLPLogExporter({ url: `${endpoint}/v1/logs`, timeoutMillis: 1000 });
      const logsOwner = own(exporter);
      const processor = new BatchLogRecordProcessor({ exporter, maxQueueSize: 1024, scheduledDelayMillis: 1000, exportTimeoutMillis: 1500 });
      own(processor, logsOwner);
      logs = new LoggerProvider({ resource, processors: [processor] });
      own(logs, logsOwner);
    }
    // Publish all providers atomically. No business operation sees a partial SDK.
    state.sdk = { tracer, meter, logs };
    state.cleanups = cleanups;
    state.phase = "ready";
  } catch {
    state.phase = "failed";
    state.initializationError = "INITIALIZATION_FAILED";
    void cleanupResources(cleanups, "failed");
  }
  return getTelemetryState();
}
const disabledTracer = new ProxyTracerProvider().getTracer("eap-disabled");
export function getTracer() { return state.sdk?.tracer.getTracer("eap-agent", "0.1.0") ?? disabledTracer; }
export function getMeter() { return state.sdk?.meter.getMeter("eap-agent", "0.1.0"); }
export async function shutdownTelemetry(timeoutMs = 2000) {
  if (!state.cleanup) {
    if (!state.sdk) { if (state.initializationError === "CLEANUP_FAILED") return; state.phase = "idle"; state.initializationError = undefined; return; }
    const cleanups = state.cleanups;
    // Disable new telemetry immediately; keep retiring resources owned until cleanup really completes.
    state.sdk = undefined;
    state.cleanups = [];
    instruments.clear();
    state.phase = "shutting-down";
    cleanupResources(cleanups, "idle");
  }
  const cleanup = state.cleanup!;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 2000;
  try {
    await Promise.race([cleanup, new Promise<void>((resolve) => { timer = setTimeout(resolve, bound); })]);
  } finally { if (timer) clearTimeout(timer); }
}
export function currentTraceId() { const id = trace.getSpan(activeContext())?.spanContext().traceId; return id && id !== "00000000000000000000000000000000" ? id : undefined; }
export function activeContext() { return state.manager.active(); }
export function withEvaluationTelemetry<T>(fn:()=>T):T { return state.identity.run({...state.identity.getStore(),evaluation:true},fn); }
export function withIdentity<T>(identity: Identity, fn: () => T): T { return state.identity.run(identity, fn); }
const allowedAttrs = new Set(["agent.run_id","agent.job_id","agent.business_trace_id","agent.model","agent.provider","agent.tool.name","agent.status","agent.error_code","agent.eval.dataset_version","http.request.method","http.route","http.response.status_code"]);
function attributes(attrs: Attributes) { return Object.fromEntries(Object.entries(attrs).filter(([key,value]) => allowedAttrs.has(key) && (typeof value === "string" || typeof value === "number"))); }
export function startSpan(name: string, attrs: Attributes = {}, parent = activeContext(), kind = SpanKind.INTERNAL, startedAt?: number) {
  const identity = state.identity.getStore();
  const span = safe(() => getTracer().startSpan(name, { attributes: attributes({
    "agent.run_id": identity?.run_id, "agent.job_id": identity?.job_id, ...attrs }), kind, startTime: startedAt }, parent));
  const ctx = span ? trace.setSpan(parent, span) : parent;
  let ended = false;
  return {
    context: ctx,
    run<T>(fn: () => T): T { return state.manager.with(ctx, fn); },
    end(errorCode?: string) { if (ended) return; ended = true; safe(() => {
      span?.setAttribute("agent.status", errorCode ?? "completed");
      if (errorCode) { span?.setAttribute("agent.error_code", errorCode); span?.setStatus({ code: SpanStatusCode.ERROR }); }
      else span?.setStatus({ code: SpanStatusCode.OK });
      span?.end();
    }); },
  };
}
export async function inSpan<T>(name: string, attrs: Attributes, fn: () => Promise<T>, parent?: Context, resultError?: (value:T)=>string|undefined): Promise<T> {
  const span = startSpan(name, attrs, parent);
  return span.run(async () => {
    try { const result = await fn(); span.end(safe(() => resultError?.(result))); return result; }
    catch (error) { span.end(errorCode(error)); throw error; }
  });
}
export function errorCode(error: unknown): string {
  return safe(() => {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    return typeof code === "string" && /^[A-Z_]{1,64}$/.test(code) ? code : "INTERNAL_ERROR";
  }) ?? "INTERNAL_ERROR";
}

export function injectTraceHeaders(): Record<string,string> {
  const headers: Record<string,string> = {};
  safe(() => propagator.inject(activeContext(), headers, { set(carrier,key,value) { carrier[key] = String(value); } }));
  return headers;
}
export function extractTraceContext(headers: Record<string,unknown> = {}): Context {
  // Never propagate baggage/tracestate or arbitrary headers, which may contain user data.
  const carrier = typeof headers.traceparent === "string" ? { traceparent: headers.traceparent } : {};
  return safe(() => propagator.extract(ROOT_CONTEXT, carrier, { keys: (c) => Object.keys(c), get: (c,k) => c[k as keyof typeof c] })) ?? ROOT_CONTEXT;
}
export function log(level: "info"|"warn"|"error", event: string, fields: Identity & { error_code?: string } = {}) {
  safe(() => {
    const span = trace.getSpan(activeContext())?.spanContext();
    const ids = { ...state.identity.getStore(), ...fields };
    const clean: Record<string,string> = {};
    for (const key of ["run_id", "job_id", "worker_id", "error_code"] as const) {
      const value = ids[key];
      if (typeof value === "string" && /^[\w.-]{1,100}$/.test(value) && !/^(sk-|Bearer|postgres|password|token)/i.test(value)) clean[key] = value;
    }
    const message = /^[a-z][a-z0-9_.-]{0,80}$/.test(event) ? event : "redacted_event";
    const record = { timestamp: new Date().toISOString(), level, service: state.service, message,
      trace_id: span?.traceId === "00000000000000000000000000000000" ? null : span?.traceId ?? null,
      span_id: span?.spanId === "0000000000000000" ? null : span?.spanId ?? null,
      run_id: null, job_id: null, worker_id: null, error_code: null, ...clean };
    safe(() => state.sink(JSON.stringify(record)));
    state.sdk?.logs?.getLogger("eap-agent").emit({ context: activeContext(), body: message,
      severityNumber: level === "error" ? SeverityNumber.ERROR : level === "warn" ? SeverityNumber.WARN : SeverityNumber.INFO,
      severityText: level, attributes: { ...clean, service: state.service } });
  });
}
const counterNames = new Set(["agent_eval_runs_total","agent_eval_regressions_total","agent_eval_gate_failures_total","agent_approvals_requested_total","agent_approvals_decided_total","agent_runs_total","agent_worker_claims_total","agent_worker_lease_renewal_failures_total","agent_worker_blocked_jobs_total","agent_model_requests_total","agent_model_tokens_total","agent_model_estimated_cost_usd_total","agent_tool_executions_total"]);
const histogramNames = new Set(["agent_eval_case_duration_seconds","agent_approval_wait_duration_seconds","agent_run_duration_seconds","agent_queue_wait_seconds","agent_model_duration_seconds","agent_tool_duration_seconds"]);
const gaugeNames = new Set(["agent_active_runs","agent_worker_active_jobs"]);
const instruments = state.instruments;
const labelKeys = new Set(["dataset_version","provider","model","tool","status","error_code","direction","usage_source"]);
export function metric(name: string, value: number, labels: Attributes = {}) {
  safe(() => {
    if (state.identity.getStore()?.evaluation && !name.startsWith("agent_eval_")) return;
    if (!Number.isFinite(value)) return;
    const meter = getMeter(); if (!meter) return;
    const attrs = Object.fromEntries(Object.entries(labels).filter(([k,v]) => labelKeys.has(k) && typeof v === "string" && /^[\w.-]{1,80}$/.test(v)));
    let instrument = instruments.get(name);
    if (!instrument) {
      if (counterNames.has(name)) instrument = meter.createCounter(name, { unit: name.includes("cost") ? "USD" : "1" });
      else if (histogramNames.has(name)) instrument = meter.createHistogram(name, { unit: "s", advice: { explicitBucketBoundaries: [0.01,0.025,0.05,0.1,0.25,0.5,1,2.5,5,10,30,60,120] } });
      else if (name === "agent_approvals_pending" || name === "agent_eval_score") instrument = meter.createGauge(name, { unit: "1" });
      else if (gaugeNames.has(name)) instrument = meter.createUpDownCounter(name, { unit: "1" });
      else return;
      instruments.set(name, instrument);
    }
    if (!gaugeNames.has(name) && value < 0) return;
    instrument.add?.(value, attrs); instrument.record?.(value, attrs);
  });
}

export async function observeOperation<T>(kind: "model"|"tool", attrs: Attributes, fn: () => Promise<T>,
  resultError?: (result:T)=>string|undefined, parent?: Context): Promise<T> {
  const span = startSpan(`agent.${kind === "model" ? "model.request" : "tool.execute"}`, attrs, parent);
  const start = performance.now();
  let code: string | undefined;
  return span.run(async () => {
    try { const result = await fn(); code = safe(() => resultError?.(result)); return result; }
    catch (error) { code = errorCode(error); throw error; }
    finally {
      safe(() => {
        const labels = { provider: attrs["agent.provider"], model: attrs["agent.model"], tool: attrs["agent.tool.name"], status: code ? "error" : "success" };
        metric(kind === "model" ? "agent_model_requests_total" : "agent_tool_executions_total",1,labels);
        metric(kind === "model" ? "agent_model_duration_seconds" : "agent_tool_duration_seconds",(performance.now()-start)/1000,labels);
      });
      span.end(code);
    }
  });
}

export async function* observeModelStream<T>(factory: () => AsyncIterable<T>, attrs: Attributes, parent?: Context): AsyncGenerator<T> {
  const span = startSpan("agent.model.request", attrs, parent);
  const started = performance.now();
  let code: string | undefined;
  let completed = false;
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  let iterator: AsyncIterator<T> | undefined;
  try {
    const source = span.run(() => factory()[Symbol.asyncIterator]());
    iterator = source;
    while (true) {
      const next = await span.run(() => source.next());
      if (next.done) { completed = true; break; }
      const event = next.value as { type?: string; code?: string; usage?: { inputTokens:number;outputTokens:number } };
      if (event.type === "error") code = event.code ?? "MODEL_ERROR";
      if (event.type === "usage") {
        // Provider Usage is a cumulative request snapshot, never a token delta.
        // Buffer the latest valid snapshot; a later invalid snapshot invalidates the candidate.
        const candidate = event.usage;
        usage = candidate && Number.isSafeInteger(candidate.inputTokens) && candidate.inputTokens >= 0 &&
          Number.isSafeInteger(candidate.outputTokens) && candidate.outputTokens >= 0
          ? { inputTokens: candidate.inputTokens, outputTokens: candidate.outputTokens } : undefined;
      }
      yield next.value;
    }
  } catch (error) { code = errorCode(error); throw error; }
  finally {
    // On error/early return, do not commit an unconfirmed Usage snapshot or mask the business error.
    if (!completed) safe(() => { void span.run(() => iterator?.return?.())?.catch(() => {}); });
    if (completed && !code && usage) safe(() => {
      const labels = { provider: attrs["agent.provider"], model: attrs["agent.model"], usage_source: "reported" };
      metric("agent_model_tokens_total",usage!.inputTokens,{...labels,direction:"input"});
      metric("agent_model_tokens_total",usage!.outputTokens,{...labels,direction:"output"});
      const cost = estimateCost(String(attrs["agent.provider"]),String(attrs["agent.model"]),usage!.inputTokens,usage!.outputTokens);
      if (cost.usd !== null) metric("agent_model_estimated_cost_usd_total",cost.usd,labels);
    });
    safe(() => {
      const labels = { provider: attrs["agent.provider"], model: attrs["agent.model"], status: code ? "error" : completed ? "success" : "interrupted" };
      metric("agent_model_requests_total",1,labels);
      metric("agent_model_duration_seconds",(performance.now()-started)/1000,labels);
    });
    span.end(code ?? (completed ? undefined : "INTERRUPTED"));
  }
}
