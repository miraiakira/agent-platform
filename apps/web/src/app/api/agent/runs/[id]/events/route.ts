import { eventStore, store } from "@/lib/persistence";
import { asyncAgentAccess, validRunId } from "@/lib/async-agent-access";
import { runEventStream } from "@/lib/run-event-stream";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = asyncAgentAccess(request);
  if (denied) return denied;
  const { id } = await context.params;
  if (!validRunId(id)) return Response.json({ error: "Invalid run ID" }, { status: 400 });
  const cursor = request.headers.get("last-event-id") ?? new URL(request.url).searchParams.get("after") ?? "0";
  if (!/^\d{1,19}$/.test(cursor) || BigInt(cursor) > BigInt("9223372036854775807")) return Response.json({ error: "Invalid event cursor" }, { status: 400 });
  try {
    if (!await store.getRun(id)) return Response.json({ error: "Run not found" }, { status: 404 });
    return new Response(runEventStream({ runId: id, cursor, signal: request.signal, events: eventStore, store }), {
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
    });
  } catch { return Response.json({ error: "Database unavailable" }, { status: 503 }); }
}
