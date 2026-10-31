import type { AgentEventStore, PersistenceStore } from "@eap/persistence";

export function waitForPoll(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

export function runEventStream(options: {
  runId: string; cursor: string; signal: AbortSignal;
  events: Pick<AgentEventStore, "listAfter">;
  store: Pick<PersistenceStore, "getRun">;
  pollMs?: number;
}) {
  const local = new AbortController();
  const signal = AbortSignal.any([options.signal, local.signal]);
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let cursor = options.cursor;
      try {
        while (!signal.aborted) {
          const events = await options.events.listAfter(options.runId, cursor, 100);
          if (signal.aborted) break;
          for (const event of events) {
            controller.enqueue(encoder.encode(`id: ${event.id}\ndata: ${JSON.stringify(event.payload)}\n\n`));
            cursor = event.id;
          }
          const run = await options.store.getRun(options.runId);
          if (!run) break;
          if (["completed", "failed", "cancelled", "interrupted"].includes(run.status)) {
            // Re-read after observing committed terminal state; drain all pages.
            if ((await options.events.listAfter(options.runId, cursor, 1)).length) continue;
            break;
          }
          if (!signal.aborted) controller.enqueue(encoder.encode(": keep-alive\n\n"));
          await waitForPoll(options.pollMs ?? 1000, signal);
        }
      } catch (error) {
        if (!signal.aborted) controller.error(error);
      } finally {
        try { controller.close(); } catch { /* Consumer already cancelled. */ }
      }
    },
    cancel() { local.abort(); },
  });
}
