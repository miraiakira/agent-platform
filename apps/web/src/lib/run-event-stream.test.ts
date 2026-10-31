import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentEventStore, AgentJobQueue, JobLifecycle, PersistenceStore } from "@eap/persistence";
import { createTestDatabase } from "../../../../packages/persistence/tests/database";
import { runEventStream, waitForPoll } from "./run-event-stream";
import { readSSE } from "./sse";

// Real PostgreSQL; no database mocks and no worker coupling to the SSE signal.
describe("persisted run SSE", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeEach(async () => { database = await createTestDatabase(); });
  afterEach(async () => { await database?.close(); });

  it("streams committed events, disconnects independently and resumes through a terminal event", async () => {
    const lifecycle = new JobLifecycle(database.pool);
    const store = new PersistenceStore(database.pool);
    const events = new AgentEventStore(database.pool);
    const queue = new AgentJobQueue(database.pool);
    const run = await lifecycle.submit({ requestKey: crypto.randomUUID(), messages: [{ role: "user", content: "hi" }] });
    const job = (await queue.claim("sse-worker"))!;
    const append = (text: string) => events.append({ runId: run.id, jobId: job.id, leaseToken: job.lease_token, type: "text-delta", payload: { type: "text-delta", text } });
    await append("first");
    const disconnect = new AbortController();
    const stream = runEventStream({ runId: run.id, cursor: "0", signal: disconnect.signal, events, store, pollMs: 1 });
    let cursor = "0";
    for await (const event of readSSE(stream, (id) => { cursor = id; })) {
      expect(event).toEqual({ type: "text-delta", text: "first" });
      break;
    }
    disconnect.abort();
    // Disconnecting the SSE subscriber must not cancel or modify the running job.
    expect((await queue.getJobByRunId(run.id))?.status).toBe("running");
    expect(await append("second")).not.toBeNull();
    await lifecycle.finalizeJob({ jobId: job.id, leaseToken: job.lease_token, status: "completed", answer: "firstsecond" });
    const resumed = runEventStream({ runId: run.id, cursor, signal: new AbortController().signal, events, store });
    const received = [];
    for await (const event of readSSE(resumed)) received.push(event);
    expect(received).toEqual([{ type: "text-delta", text: "second" }, { type: "done" }]);
  });

  it("removes each polling abort listener on timeout and cancellation", async () => {
    const controller = new AbortController();
    for (let index = 0; index < 15; index++) {
      await waitForPoll(1, controller.signal);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    }
    const waiting = waitForPoll(10_000, controller.signal);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
    controller.abort(); await waiting;
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});
