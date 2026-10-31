import { readSSE, type ChatStreamEvent } from "./sse";

/** Reconnect only the subscription. A reconnect never POSTs another job. */
export async function* subscribeRun(url: string, signal: AbortSignal): AsyncGenerator<ChatStreamEvent> {
  let cursor = "0";
  let failures = 0;
  while (!signal.aborted) {
    try {
      const response = await fetch(url, { headers: { "Last-Event-ID": cursor }, signal });
      if (!response.ok || !response.body) throw new Error(`Subscription failed: ${response.status}`);
      for await (const event of readSSE(response.body, (id) => { cursor = id; failures = 0; })) {
        yield event;
        if (event.type === "done" || event.type === "error") return;
      }
      throw new Error("Subscription disconnected");
    } catch (error) {
      if (signal.aborted) return;
      if (++failures > 3) throw error;
      await new Promise<void>((resolve) => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, 300 * failures);
        signal.addEventListener("abort", finish, { once: true });
        if (signal.aborted) finish();
      });
    }
  }
}
