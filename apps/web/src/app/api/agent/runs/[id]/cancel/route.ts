import { inSpan, extractTraceContext } from "@eap/observability";
import { store, jobQueue } from "@/lib/persistence";
import { asyncAgentAccess, validRunId } from "@/lib/async-agent-access";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = asyncAgentAccess(request);
  if (denied) return denied;
  const { id } = await context.params;
  if (!validRunId(id)) return Response.json({ error: "Invalid run ID" }, { status: 400 });
  try {
    if (!await store.getRun(id)) return Response.json({ error: "Run not found" }, { status: 404 });
    const accepted = await inSpan("agent.job.cancel", { "agent.run_id": id }, () => jobQueue.requestCancellation(id), extractTraceContext({ traceparent: request.headers.get("traceparent") }));
    return Response.json({ accepted }, { status: accepted ? 202 : 409 });
  } catch { return Response.json({ error: "Database unavailable" }, { status: 503 }); }
}
