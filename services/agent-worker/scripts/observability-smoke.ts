import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import { initTelemetry, shutdownTelemetry, inSpan } from "@eap/observability";
import { JobLifecycle, PersistenceStore } from "@eap/persistence";
import { createTestDatabase } from "../../../packages/persistence/tests/database";

async function waitFor<T>(read: () => Promise<T>, accept: (value:T)=>boolean, timeoutMs = 20_000): Promise<T> {
  const until = Date.now()+timeoutMs;
  while (true) {
    try { const value = await read(); if (accept(value)) return value; } catch { /* readiness/export lag */ }
    if (Date.now() >= until) throw new Error("Observability smoke timed out waiting for committed data/export");
    await new Promise((resolve)=>setTimeout(resolve,200));
  }
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null) { assert.equal(child.exitCode,0); return; }
  const exited = once(child,"exit");
  child.kill("SIGTERM");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [exitCode, exitSignal] = await Promise.race([exited,new Promise<never>((_,reject)=>{
      timer=setTimeout(()=>{child.kill("SIGKILL");reject(new Error("Worker telemetry shutdown exceeded 5s"))},5000);
    })]);
    assert.equal(exitCode,0); assert.equal(exitSignal,null);
  } finally { if(timer) clearTimeout(timer); }
}
let stage = "database.setup";
async function main() {
  const database = await createTestDatabase();
  let worker: ChildProcess | undefined;
  initTelemetry({service:"eap-web-smoke",enabled:true});
  try {
    const store = new PersistenceStore(database.pool);
    const lifecycle = new JobLifecycle(database.pool);
    const run = await inSpan("agent.job.submit",{},()=>lifecycle.submit({requestKey:crypto.randomUUID(),messages:[{role:"user",content:"query risk"}]}));
    const schema = (await database.pool.query("SELECT current_schema() AS name")).rows[0].name;
    worker = spawn(process.execPath,["--import",import.meta.resolve("tsx"),"src/index.ts"],{
      cwd: new URL("../",import.meta.url), stdio:["ignore","pipe","pipe"],
      env:{...process.env,DATABASE_URL:process.env.TEST_DATABASE_URL,PGOPTIONS:`-c search_path=${schema}`,
        OTEL_ENABLED:"true",LLM_PROVIDER:"mock",WORKER_POLL_INTERVAL_MS:"20"},
    });
    // Drain child logs without echoing arbitrary process diagnostics or business data.
    worker.stdout?.resume(); worker.stderr?.resume();
    stage = "worker.execute";
    const result = await waitFor(()=>store.getRun(run.id),(r)=>r?.status==="completed");
    const metadata=result!.observability as {otelTraceId:string};
    assert.match(metadata.otelTraceId,/^[a-f0-9]{32}$/);
    stage = "worker.shutdown";
    await stop(worker); worker=undefined;
    await shutdownTelemetry();
    if (process.env.OBSERVABILITY_FAULT_TEST === "true") {
      const summary=await store.usageByModel(); assert.equal(summary[0].total_tokens,"80");
      console.log(JSON.stringify({runId:run.id,collectorUnavailable:"Agent still completed",workerShutdown:"bounded",usageSnapshot:"passed"}));
      return;
    }
    const grafana=process.env.GRAFANA_URL ?? "http://127.0.0.1:3000";
    async function get(path:string) { const response=await fetch(grafana+path);assert(response.ok);return response.json(); }
    stage = "tempo.trace";
    const requiredSpans=["agent.job.submit","agent.run","agent.model.request","agent.tool.execute","business.http"];
    // Tempo can return a partial trace before the other exporters/Collector batches arrive.
    const trace=await waitFor(()=>get(`/api/datasources/proxy/uid/tempo/api/traces/${metadata.otelTraceId}`),
      (value)=>requiredSpans.every((name)=>JSON.stringify(value).includes(name)));
    const traceJSON=JSON.stringify(trace);
    for(const name of requiredSpans) assert(traceJSON.includes(name),`Missing ${name}`);
    const query="agent_model_tokens_total";
    stage = "prometheus.metrics";
    const metrics=await waitFor(()=>get(`/api/datasources/proxy/uid/prometheus/api/v1/query?query=${query}`),(v)=>v.data?.result?.length>0);
    assert(metrics.data.result.some((r:{metric:Record<string,string>})=>r.metric.provider==="mock"));
    const logQuery=`{service_name=~"eap.*"} | trace_id="${metadata.otelTraceId}"`;
    stage = "loki.logs";
    const logs=await waitFor(()=>get(`/api/datasources/proxy/uid/loki/loki/api/v1/query_range?query=${encodeURIComponent(logQuery)}&limit=100`),(v)=>JSON.stringify(v).includes("job.finished") && JSON.stringify(v).includes("http.request"));
    assert(JSON.stringify(logs).includes("job.finished"));
    stage = "grafana.trace_link";
    const lokiDatasource=await get("/api/datasources/uid/loki");
    assert.equal(lokiDatasource.jsonData.derivedFields[0].url,"${__value.raw}");
    stage = "grafana.dashboard";
    const dashboard=await get("/api/dashboards/uid/agent-overview");
    assert(dashboard.dashboard.panels.length>=12);
    for (const panel of dashboard.dashboard.panels) for (const target of panel.targets ?? []) {
      const expr=target.expr.replaceAll("$__range","5m");
      const response=await get(`/api/datasources/proxy/uid/prometheus/api/v1/query?query=${encodeURIComponent(expr)}`);
      assert.equal(response.status,"success",`Invalid Dashboard PromQL: ${expr}`);
    }
    const summary=await store.usageByModel(); assert.equal(summary[0].total_tokens,"80");
    console.log(JSON.stringify({runId:run.id,otelTraceId:metadata.otelTraceId,trace:"passed (including Go)",metrics:"passed",logs:"passed",dashboard:"provisioned",workerShutdown:"passed",usageSnapshot:"passed"}));
  } finally {
    if(worker) await stop(worker);
    await shutdownTelemetry();
    await database.close();
  }
}
main().catch((error)=>{console.error(`Observability smoke failed at ${stage}: ${error instanceof Error ? error.name : "unknown error"}`);process.exitCode=1;});
