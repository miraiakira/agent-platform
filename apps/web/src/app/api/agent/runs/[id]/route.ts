import { security } from "@/lib/persistence";
import { protectedApi } from "@/lib/security";
import { store, jobQueue } from "@/lib/persistence";
import { validRunId } from "@/lib/async-agent-access";
export const runtime = "nodejs";
async function handleGET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!validRunId(id)) return Response.json({ error: "Invalid run ID" }, { status: 400 });
  try {
    const run = await store.getRun(id);
    if (!run) return await security.resourceDenied("run",id);
    const job = await jobQueue.getJobByRunId(id);
    return Response.json({ run, job: job ? { status: job.status, cancelRequested: Boolean(job.cancel_requested_at) } : null });
  } catch(error) { if(error instanceof (await import("@eap/persistence")).SecurityError) throw error; return Response.json({ error: "Database unavailable" }, { status: 503 }); }
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
 return protectedApi(request,"agent:read",()=>handleGET(request, context));
}
