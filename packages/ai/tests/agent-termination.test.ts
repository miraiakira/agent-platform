import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "@eap/tools";
import { AgentRunner, MockProvider, RuntimeError, type ModelToolStreamEvent, type StreamEvent } from "../src";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function waitingRun(parent?: AbortSignal) {
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  class WaitingProvider extends MockProvider {
    async *streamWithTools(): AsyncIterable<ModelToolStreamEvent> {
      entered();
      // Intentionally uncooperative, matching the Worker Deadline regression.
      await new Promise<void>(() => {});
      yield { type: "model-finish", finishReason: "stop" };
    }
  }
  const runner = new AgentRunner({ provider: new WaitingProvider(), tools: new ToolRegistry(), budget: { maxDurationMs: 20 } });
  const result = (async () => {
    const events: StreamEvent[] = [];
    for await (const event of runner.run({ messages: [{ role: "user", content: "hello" }], signal: parent })) events.push(event);
    return events.at(-1);
  })();
  return { ready, result };
}

describe("AgentRunner termination classification", () => {
  it("uses the timer's deadline cause even when remaining time is still positive", async () => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockReturnValue(0);
    const run = waitingRun();
    await run.ready;
    await vi.advanceTimersByTimeAsync(20);
    expect(await run.result).toMatchObject({ type: "error", code: "DEADLINE_EXCEEDED" });
  });

  it("keeps cancellation first even when catch runs after the deadline", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const run = waitingRun(parent.signal);
    await run.ready;
    parent.abort();
    // Deliberately postpone promise continuations until after the timer fires.
    vi.advanceTimersByTime(21);
    expect(await run.result).toMatchObject({ type: "error", code: "CANCELLED" });
  });

  it("keeps deadline first even when shutdown arrives before catch runs", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const run = waitingRun(parent.signal);
    await run.ready;
    vi.advanceTimersByTime(20);
    parent.abort(new RuntimeError("WORKER_STOPPED", "Worker stopped"));
    expect(await run.result).toMatchObject({ type: "error", code: "DEADLINE_EXCEEDED" });
  });

  it.each(["CANCELLED", "WORKER_STOPPED", "LEASE_LOST", "HEARTBEAT_FAILED"])("preserves the first external reason %s", async (code) => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const run = waitingRun(parent.signal);
    await run.ready;
    parent.abort(new RuntimeError(code, code));
    vi.advanceTimersByTime(21);
    expect(await run.result).toMatchObject({ type: "error", code });
  });
});
