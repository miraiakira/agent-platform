import {
  eventStore,
  store,
} from "@/lib/persistence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ id: string }>;
};

const TERMINAL = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export async function GET(
  request: Request,
  context: Context,
) {
  const { id: runId } = await context.params;

  const run = await store.getRun(runId);

  if (!run) {
    return Response.json(
      { error: "Run not found" },
      { status: 404 },
    );
  }

  const url = new URL(request.url);

  const cursor =
    request.headers.get("last-event-id") ??
    url.searchParams.get("after") ??
    "0";

  if (!/^\d+$/.test(cursor)) {
    return Response.json(
      { error: "Invalid event cursor" },
      { status: 400 },
    );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let lastId = cursor;
      let closed = false;

      const send = (text: string) => {
        if (!closed) {
          controller.enqueue(encoder.encode(text));
        }
      };

      try {
        while (!request.signal.aborted) {
          const events = await eventStore.listAfter(
            runId,
            lastId,
            100,
          );

          for (const event of events) {
            lastId = event.id;

            send(
              `id: ${event.id}\n` +
              `data: ${JSON.stringify(event.payload)}\n\n`,
            );
          }

          const current = await store.getRun(runId);

          if (!current) break;

          if (TERMINAL.has(current.status)) {
            // 确认终态后再检查一次事件。
            const remaining = await eventStore.listAfter(
              runId,
              lastId,
              100,
            );

            if (remaining.length > 0) {
              continue;
            }

            send(
              `event: run-status\n` +
              `data: ${JSON.stringify({
                runId,
                status: current.status,
              })}\n\n`,
            );

            break;
          }

          send(": keep-alive\n\n");

          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 1000);

            request.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
        }
      } catch (error) {
        console.error("SSE subscription failed", error);
      } finally {
        closed = true;

        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}