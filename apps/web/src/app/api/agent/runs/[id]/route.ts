import { store, jobQueue } from "@/lib/persistence";
import { asyncAgentAccess, validRunId } from "@/lib/async-agent-access";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = asyncAgentAccess(request);
  if (denied) return denied;
  const { id } = await context.params;
  if (!validRunId(id)) return Response.json({ error: "Invalid run ID" }, { status: 400 });
  try {
    const run = await store.getRun(id);
    if (!run) return Response.json({ error: "Run not found" }, { status: 404 });
    const job = await jobQueue.getJobByRunId(id);
    return Response.json({ run, job: job ? { status: job.status, cancelRequested: Boolean(job.cancel_requested_at) } : null });
  } catch { return Response.json({ error: "Database unavailable" }, { status: 503 }); }
}
