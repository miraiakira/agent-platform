import { security } from "@/lib/persistence";
import { protectedApi } from "@/lib/security";
import { inSpan, extractTraceContext } from "@eap/observability";
import { store, jobQueue } from "@/lib/persistence";
import { validRunId } from "@/lib/async-agent-access";
export const runtime = "nodejs";
async function handlePOST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!validRunId(id)) return Response.json({ error: "Invalid run ID" }, { status: 400 });
  try {
    if (!await store.getRun(id)) return await security.resourceDenied("run",id);
    const accepted = await inSpan("agent.job.cancel", { "agent.run_id": id }, () => jobQueue.requestCancellation(id), extractTraceContext({ traceparent: request.headers.get("traceparent") }));
    return Response.json({ accepted }, { status: accepted ? 202 : 409 });
  } catch(error) { if(error instanceof (await import("@eap/persistence")).SecurityError) throw error; return Response.json({ error: "Database unavailable" }, { status: 503 }); }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
 return protectedApi(request,"agent:cancel",()=>handlePOST(request, context));
}
