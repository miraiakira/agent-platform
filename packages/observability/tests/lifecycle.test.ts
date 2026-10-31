import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { InMemoryMetricExporter, PeriodicExportingMetricReader, AggregationTemporality } from "@opentelemetry/sdk-metrics";
import { getTelemetryState, initTelemetry, shutdownTelemetry, getMeter, startSpan, inSpan, metric } from "../src";

const releaseAll: Array<()=>void> = [];
function gate() {
  let resolve!:()=>void;
  const promise=new Promise<void>((done)=>{resolve=done});
  releaseAll.push(resolve);
  return {promise,resolve};
}
function fixture() {
  const exporter=new InMemorySpanExporter();
  const metrics=new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader=new PeriodicExportingMetricReader({exporter:metrics,exportIntervalMillis:60_000});
  return {exporter,metrics,reader};
}
afterEach(async()=>{
  releaseAll.splice(0).forEach((resolve)=>resolve());
  vi.useRealTimers();
  try { await shutdownTelemetry(100); }
  finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});

describe("telemetry SDK ownership",()=>{
  it("reports constructor failure without marking initialization ready",async()=>{
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT","not-a-url");
    expect(initTelemetry({service:"bad-endpoint",enabled:true})).toMatchObject({phase:"failed",initializationError:"INITIALIZATION_FAILED"});
    expect(getMeter()).toBeUndefined();
    expect(await inSpan("business.without.telemetry",{},async()=>42)).toBe(42);
    await shutdownTelemetry(100);
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT","http://127.0.0.1:4318");
    const next=fixture();
    expect(initTelemetry({service:"retry",enabled:true,spanExporter:next.exporter,metricReader:next.reader}).phase).toBe("ready");
  });

  it("rolls back partial initialization and permits a retry only after cleanup",async()=>{
    const first=fixture(); const retired=gate();
    const close=vi.spyOn(first.exporter,"shutdown").mockImplementation(()=>retired.promise);
    const readerClose=vi.spyOn(first.reader,"shutdown");
    vi.spyOn(first.reader,"setMetricProducer").mockImplementation(()=>{throw new Error("metric bind failed with private config")});
    const result=initTelemetry({service:"partial",enabled:true,spanExporter:first.exporter,metricReader:first.reader});
    expect(result).toMatchObject({phase:"failed",cleanupPending:true,initializationError:"INITIALIZATION_FAILED"});
    expect(getMeter()).toBeUndefined();
    startSpan("must.not.export").end();
    expect(first.exporter.getFinishedSpans()).toHaveLength(0);
    const second=fixture();
    expect(initTelemetry({service:"retry-too-early",enabled:true,spanExporter:second.exporter,metricReader:second.reader}).cleanupPending).toBe(true);
    await shutdownTelemetry(1);
    expect(close).toHaveBeenCalledOnce(); expect(readerClose).toHaveBeenCalledOnce();
    expect(getTelemetryState().cleanupPending).toBe(true);
    retired.resolve(); await shutdownTelemetry(100);
    expect(getTelemetryState()).toMatchObject({phase:"failed",cleanupPending:false});
    expect(initTelemetry({service:"retry",enabled:true,spanExporter:second.exporter,metricReader:second.reader}).phase).toBe("ready");
    startSpan("retry.works").end();expect(second.exporter.getFinishedSpans()).toHaveLength(1);
  });

  it("does not replace an active SDK on duplicate initialization",async()=>{
    const first=fixture();const second=fixture();
    const close=vi.spyOn(first.exporter,"shutdown");
    initTelemetry({service:"first",enabled:true,spanExporter:first.exporter,metricReader:first.reader});
    initTelemetry({service:"second",enabled:true,spanExporter:second.exporter,metricReader:second.reader});
    startSpan("active").end();
    expect(first.exporter.getFinishedSpans()).toHaveLength(1);
    expect(second.exporter.getFinishedSpans()).toHaveLength(0);expect(close).not.toHaveBeenCalled();
    await second.reader.shutdown();
  });

  it("bounds every shutdown waiter but blocks reinitialization until actual SDK settlement",async()=>{
    vi.useFakeTimers();
    const first=fixture();const retired=gate();
    const close=vi.spyOn(first.exporter,"shutdown").mockImplementation(()=>retired.promise);
    initTelemetry({service:"first",enabled:true,spanExporter:first.exporter,metricReader:first.reader});
    const waiting=shutdownTelemetry(10);
    await vi.advanceTimersByTimeAsync(10);await waiting;
    expect(getTelemetryState()).toMatchObject({phase:"shutting-down",cleanupPending:true});
    expect(getMeter()).toBeUndefined();
    expect(await inSpan("business.during.shutdown",{},async()=>42)).toBe(42);
    const second=fixture();
    expect(initTelemetry({service:"second",enabled:true,spanExporter:second.exporter,metricReader:second.reader}).phase).toBe("shutting-down");
    const another=shutdownTelemetry(5);
    await vi.advanceTimersByTimeAsync(5);await another;
    expect(close).toHaveBeenCalledOnce();
    retired.resolve();await shutdownTelemetry(100);
    expect(getTelemetryState()).toMatchObject({phase:"idle",cleanupPending:false});
    vi.useRealTimers();
    initTelemetry({service:"second",enabled:true,spanExporter:second.exporter,metricReader:second.reader});
    metric("agent_runs_total",1);await second.reader.forceFlush();
    expect(second.metrics.getMetrics()[0].scopeMetrics[0].metrics[0].dataPoints[0].value).toBe(1);
  });

  it("preserves SDK ownership when the module is hot-reloaded during shutdown",async()=>{
    const first=fixture();const retired=gate();
    const close=vi.spyOn(first.exporter,"shutdown").mockImplementation(()=>retired.promise);
    initTelemetry({service:"first",enabled:true,spanExporter:first.exporter,metricReader:first.reader});
    await shutdownTelemetry(1);
    vi.resetModules();
    const reloaded=await import("../src/index");
    const second=fixture();
    expect(reloaded.initTelemetry({service:"second",enabled:true,spanExporter:second.exporter,metricReader:second.reader}).cleanupPending).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    retired.resolve();await reloaded.shutdownTelemetry(100);
    expect(reloaded.initTelemetry({service:"second",enabled:true,spanExporter:second.exporter,metricReader:second.reader}).phase).toBe("ready");
    reloaded.startSpan("after.reload").end();expect(second.exporter.getFinishedSpans()).toHaveLength(1);
    reloaded.metric("agent_runs_total",2);
    // The original module's shutdown hook must also invalidate the reloaded module's cache.
    await shutdownTelemetry(100);
    const third=fixture();
    reloaded.initTelemetry({service:"third",enabled:true,spanExporter:third.exporter,metricReader:third.reader});
    reloaded.metric("agent_runs_total",3);await third.reader.forceFlush();
    expect(third.metrics.getMetrics()[0].scopeMetrics[0].metrics[0].dataPoints[0].value).toBe(3);
  });

  it("keeps business exceptions intact when initialization fails",async()=>{
    const first=fixture();
    vi.spyOn(first.reader,"setMetricProducer").mockImplementation(()=>{throw new Error("SDK unavailable")});
    initTelemetry({service:"failed",enabled:true,spanExporter:first.exporter,metricReader:first.reader});
    const error=new Error("business failure");
    await expect(inSpan("business",{},async()=>{throw error})).rejects.toBe(error);
    await shutdownTelemetry(100);
  });


});
