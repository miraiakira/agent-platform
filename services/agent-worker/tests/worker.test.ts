import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockProvider, type ModelToolStreamEvent, type StreamWithToolsOptions } from "@eap/ai";
import { z } from "zod";
import { createBusinessTools, ToolRegistry, ToolError } from "@eap/tools";
import { AgentEventStore, AgentJobQueue, JobLifecycle, PersistenceStore } from "@eap/persistence";
import { createTestDatabase } from "../../../packages/persistence/tests/database";
import { AgentExecutor, type JobExecutor } from "../src/executor";
import { runWorker } from "../src/worker";
import { runEventStream } from "../../../apps/web/src/lib/run-event-stream";
import { readSSE } from "../../../apps/web/src/lib/sse";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function until(check: () => Promise<boolean>) {
  const timeout = Date.now() + 5000;
  while (!await check()) {
    if (Date.now() >= timeout) throw new Error("Timed out waiting for database state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

class WaitingProvider extends MockProvider {
  constructor(private readonly onEnter?: () => void) { super(); }
  async *streamWithTools(options: StreamWithToolsOptions): AsyncIterable<ModelToolStreamEvent> {
    void options;
    this.onEnter?.();
    // Simulate a provider which never responds to abort.
    await new Promise<void>(() => {});
    yield { type: "model-finish", finishReason: "stop" };
  }
}

describe("real Agent worker integration", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let queue: AgentJobQueue;
  let lifecycle: JobLifecycle;
  let store: PersistenceStore;
  let events: AgentEventStore;
  const stops: AbortController[] = [];
  const workers: Promise<void>[] = [];
  beforeEach(async () => {
    database = await createTestDatabase();
    queue = new AgentJobQueue(database.pool);
    lifecycle = new JobLifecycle(database.pool);
    store = new PersistenceStore(database.pool);
    events = new AgentEventStore(database.pool);
  });
  afterEach(async () => {
    stops.splice(0).forEach((stop) => stop.abort());
    await Promise.all(workers.splice(0));
    await database?.close();
  });
  const submit = () => lifecycle.submit({ requestKey: crypto.randomUUID(), messages: [{ role: "user", content: "查询高风险交易" }] });
  function executor(provider = new MockProvider(), tools = new ToolRegistry()) {
    return new AgentExecutor({ store, events, lifecycle, provider, tools });
  }
  function start(exec: JobExecutor, concurrency = 1) {
    const stop = new AbortController();
    stops.push(stop);
    const running = runWorker({ queue, lifecycle, executor: exec, workerId: crypto.randomUUID(), signal: stop.signal,
      concurrency, leaseSeconds: 0.3, pollIntervalMs: 10, onError: () => {} });
    workers.push(running);
    return { stop, running };
  }

  it("runs MockProvider and real ToolRegistry, persists answer, trace, usage and exactly one terminal event", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ items: [], total: 0 }));
    const tools = createBusinessTools({ baseURL: "http://business.test", fetchImpl });
    const run = await submit();
    start(executor(new MockProvider(), tools));
    await until(async () => (await store.getRun(run.id))?.status === "completed");
    const saved = (await store.getRun(run.id))!;
    expect(saved.output).toEqual({ answer: '模拟风控分析结果：{"items":[],"total":0}' });
    expect(saved.model_calls).toBe(3);
    expect(saved.tool_calls).toBe(1);
    expect(saved.input_tokens).toBe(50);
    expect(saved.output_tokens).toBe(30);
    expect(await store.listSpans(run.id)).toHaveLength(4);
    expect(await store.listMessages(run.conversation_id)).toHaveLength(2);
    const all = await events.listAfter(run.id, "0", 500);
    expect(all.filter((e) => e.event_type === "done")).toHaveLength(1);
    expect(all.at(-1)?.event_type).toBe("done");
    expect(fetchImpl).toHaveBeenCalledOnce();
    // Read/reconnect operations cannot invoke the executor again.
    await events.listAfter(run.id, all[2]!.id, 500);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("continues real AgentRunner execution after its SSE subscriber disconnects", async () => {
    const entered = deferred(); const release = deferred();
    class GatedProvider extends MockProvider {
      async *streamWithTools(options: StreamWithToolsOptions): AsyncIterable<ModelToolStreamEvent> {
        entered.resolve();
        await release.promise;
        yield* super.streamWithTools(options);
      }
    }
    const run = await submit();
    start(executor(new GatedProvider()));
    await entered.promise;
    const stream = runEventStream({ runId: run.id, cursor: "0", signal: new AbortController().signal, events, store, pollMs: 1 });
    for await (const event of readSSE(stream)) {
      expect(event.type).toBe("run-start");
      break;
    }
    release.resolve();
    await until(async () => (await store.getRun(run.id))?.status === "completed");
    expect((await store.getRun(run.id))?.output).toEqual({ answer: "模拟 Agent 回答" });
  });

  it("recovers from a transient claim failure without dropping a job", async () => {
    const run = await submit();
    const claim = vi.spyOn(queue, "claim").mockRejectedValueOnce(new Error("temporary database failure"));
    start(executor());
    await until(async () => (await store.getRun(run.id))?.status === "completed");
    expect(claim.mock.calls.length).toBeGreaterThan(1);
  });

  it("enforces the global AgentRunner deadline", async () => {
    const run = await submit();
    start(new AgentExecutor({ store, events, lifecycle, provider: new WaitingProvider(), tools: new ToolRegistry(), maxDurationMs: 20 }));
    await until(async () => (await store.getRun(run.id))?.status === "failed");
    expect((await store.getRun(run.id))?.error).toMatchObject({ code: "DEADLINE_EXCEEDED" });
  });

  it("does not overwrite a completed deadline result with a later worker shutdown", async () => {
    const run = await submit();
    const real = new AgentExecutor({ store, events, lifecycle, provider: new WaitingProvider(), tools: new ToolRegistry(), maxDurationMs: 20 });
    let code: string | undefined;
    const worker = start({ async execute(job, signal) {
      const result = await real.execute(job, signal);
      code = result.error?.code;
      worker.stop.abort();
      return result;
    } });
    await worker.running;
    expect(code).toBe("DEADLINE_EXCEEDED");
    expect((await store.getRun(run.id))?.error).toMatchObject({ code: "DEADLINE_EXCEEDED" });
  });

  it("reports lease loss distinctly while fencing all final result writes", async () => {
    const run = await submit();
    const entered = deferred(); const returned = deferred();
    const real = executor(new WaitingProvider(entered.resolve));
    let code: string | undefined;
    const worker = start({ async execute(job, signal) {
      const result = await real.execute(job, signal);
      code = result.error?.code;
      returned.resolve();
      return result;
    } });
    await entered.promise;
    // Expire the actual DB lease before the next heartbeat; do not fake cancellation.
    await database.pool.query("UPDATE agent_jobs SET lease_expires_at=now()-interval '1 second' WHERE run_id=$1", [run.id]);
    await returned.promise;
    worker.stop.abort(); await worker.running;
    expect(code).toBe("LEASE_LOST");
    expect((await store.getRun(run.id))?.output).toBeNull();
    expect((await events.listAfter(run.id, "0", 500)).some((e) => e.event_type === "done")).toBe(false);
  });

  it("preserves heartbeat failure instead of converting it to user cancellation", async () => {
    const run = await submit();
    vi.spyOn(queue, "renewLease").mockRejectedValueOnce(new Error("database temporarily unavailable"));
    const real = executor(new WaitingProvider());
    let code: string | undefined;
    const worker = start({ async execute(job, signal) {
      const result = await real.execute(job, signal);
      code = result.error?.code;
      return result;
    } });
    await until(async () => (await store.getRun(run.id))?.status === "failed");
    worker.stop.abort(); await worker.running;
    expect(code).toBe("HEARTBEAT_FAILED");
    expect((await store.getRun(run.id))?.error).toMatchObject({ code: "HEARTBEAT_FAILED" });
  });

  it("fences a worker that loses its lease before returning results", async () => {
    const entered = deferred(); const release = deferred();
    const run = await submit();
    const real = executor();
    const exec: JobExecutor = { async execute(job, signal) {
      const result = await real.execute(job, signal);
      entered.resolve();
      await release.promise;
      return result;
    } };
    const worker = start(exec);
    await entered.promise;
    await database.pool.query("UPDATE agent_jobs SET lease_expires_at=now()-interval '1 second' WHERE run_id=$1", [run.id]);
    release.resolve();
    await until(async () => (await queue.getJobByRunId(run.id))?.status === "blocked");
    worker.stop.abort(); await worker.running;
    expect((await store.getRun(run.id))?.status).toBe("interrupted");
    expect((await store.listMessages(run.conversation_id)).filter((m) => m.role === "assistant")).toHaveLength(0);
    expect((await events.listAfter(run.id, "0", 500)).some((e) => e.event_type === "done")).toBe(false);
  });

  it("aborts the actual AgentRunner when cancellation is observed", async () => {
    const entered = deferred();
    class GatedProvider extends MockProvider {
      async *streamWithTools(options: StreamWithToolsOptions): AsyncIterable<ModelToolStreamEvent> {
        entered.resolve();
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) resolve();
          else options.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        yield { type: "model-finish", finishReason: "stop" };
      }
    }
    const run = await submit();
    start(executor(new GatedProvider()));
    await entered.promise;
    await queue.requestCancellation(run.id);
    await until(async () => (await store.getRun(run.id))?.status === "cancelled");
    expect((await queue.getJobByRunId(run.id))?.status).toBe("cancelled");
    expect((await events.listAfter(run.id, "0")).at(-1)?.payload).toMatchObject({ type: "error", code: "CANCELLED" });
  });

  it("never retries or replays an unknown side-effect tool result", async () => {
    const tools = new ToolRegistry();
    const execute = vi.fn(async () => { throw new ToolError("UPSTREAM_ERROR", "Transfer response lost after dispatch"); });
    tools.register({ name: "get_high_risk_transactions", description: "Unsafe test tool", retrySafe: false,
      schema: z.object({ date: z.string(), limit: z.number() }), parameters: {}, execute });
    const run = await submit();
    const worker = start(executor(new MockProvider(), tools));
    await until(async () => (await queue.getJobByRunId(run.id))?.status === "blocked");
    worker.stop.abort(); await worker.running;
    expect(execute).toHaveBeenCalledOnce();
    expect((await store.getToolExecution(`${run.id}:mock-call-1`)).status).toBe("unknown");
    expect(await queue.claim("replay-attempt")).toBeNull();
    expect((await store.getRun(run.id))?.status).toBe("interrupted");
  });

  it("blocks a crashed worker and retains unknown tool intent without replay", async () => {
    const run = await submit();
    const job = (await queue.claim("crashed"))!;
    expect(await lifecycle.startTool(job.id, job.lease_token, { id: "transfer-1", name: "transfer", arguments: '{"amount":10}' })).toBe(true);
    expect(await lifecycle.startTool(job.id, job.lease_token, { id: "transfer-1", name: "transfer", arguments: '{"amount":10}' })).toBe(false);
    await database.pool.query("UPDATE agent_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [job.id]);
    expect(await queue.blockExpiredJobs()).toEqual([run.id]);
    expect(await queue.claim("other-worker")).toBeNull();
    const intent = await store.getToolExecution(`${run.id}:transfer-1`);
    expect(intent.status).toBe("unknown");
    expect(intent.tool_call_id).toBe("transfer-1");
    expect(await lifecycle.finishTool(job.id, job.lease_token, "transfer-1", { success: true, content: "ok" })).toBe(false);
  });

  it("multiple workers finish each queued run once and exit gracefully", async () => {
    const runs = await Promise.all([submit(), submit(), submit(), submit()]);
    const execute = vi.fn((job, signal) => executor().execute(job, signal));
    const a = start({ execute }, 2); const b = start({ execute }, 2);
    await until(async () => (await database.pool.query("SELECT count(*)::int AS n FROM agent_jobs WHERE status='completed'")).rows[0].n === runs.length);
    a.stop.abort(); b.stop.abort(); await Promise.all([a.running, b.running]);
    expect(execute).toHaveBeenCalledTimes(4);
    expect(new Set(execute.mock.calls.map(([job]) => job.id)).size).toBe(4);
  });

  it("shuts down a running provider and does not label shutdown as user cancellation", async () => {
    const entered = deferred();
    class SlowProvider extends MockProvider {
      async *streamWithTools(options: StreamWithToolsOptions): AsyncIterable<ModelToolStreamEvent> {
        entered.resolve();
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) resolve();
          else options.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        yield { type: "model-finish", finishReason: "stop" };
      }
    }
    const run = await submit();
    const worker = start(executor(new SlowProvider()));
    await entered.promise;
    worker.stop.abort(); await worker.running;
    expect((await store.getRun(run.id))?.status).toBe("failed");
    expect((await store.getRun(run.id))?.error).toMatchObject({ code: "WORKER_STOPPED" });
  });
});
