import { expect, it, vi } from "vitest";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { InMemoryMetricExporter, PeriodicExportingMetricReader, AggregationTemporality } from "@opentelemetry/sdk-metrics";
import { initTelemetry, shutdownTelemetry, getTelemetryState, inSpan } from "../src";

// An isolated file: production intentionally cannot reset a failed cleanup latch.
it("requires restart after SDK cleanup rejects", async()=>{
  const exporter=new InMemorySpanExporter();
  const reader=new PeriodicExportingMetricReader({exporter:new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),exportIntervalMillis:60_000});
  vi.spyOn(exporter,"shutdown").mockRejectedValue(new Error("SDK close failed"));
  initTelemetry({service:"first",enabled:true,spanExporter:exporter,metricReader:reader});
  await shutdownTelemetry(100);
  expect(getTelemetryState()).toMatchObject({phase:"failed",cleanupPending:false,initializationError:"CLEANUP_FAILED"});
  expect(initTelemetry({service:"must-not-start",enabled:true}).phase).toBe("failed");
  expect(await inSpan("business.after.close.failure",{},async()=>"ok")).toBe("ok");
  await shutdownTelemetry(1);
  expect(getTelemetryState().initializationError).toBe("CLEANUP_FAILED");
});
