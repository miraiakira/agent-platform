import { protectedApi } from "@/lib/security";
import { inSpan, extractTraceContext, log, errorCode } from "@eap/observability";
import { z } from "zod";
import { securityContext } from "@eap/persistence";
import { security } from "@/lib/persistence";
import { JobRequestError } from "@eap/persistence";
import { jobLifecycle } from "@/lib/persistence";

export const runtime = "nodejs";
const schema = z.object({
  conversationId: z.string().uuid().optional(),
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(8000) }).strict()).min(1).max(20),
}).strict();

async function handlePOST(request: Request) {
  const requestKey = request.headers.get("idempotency-key");
  if (!requestKey || !/^[a-zA-Z0-9_-]{1,128}$/.test(requestKey)) return Response.json({ error: "Valid Idempotency-Key required" }, { status: 400 });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  await security.limit(`job:${securityContext()?.tenantId}:${securityContext()?.actorUserId}`,20,60);
  try {
    const run = await inSpan("agent.job.submit", {}, () => jobLifecycle.submit({ ...parsed.data, requestKey }), extractTraceContext({ traceparent: request.headers.get("traceparent") }));
    return Response.json({ runId: run.id, conversationId: run.conversation_id, status: run.status,
      eventsUrl: `/api/agent/runs/${run.id}/events` }, { status: 202 });
  } catch (error) {
    if (error instanceof (await import("@eap/persistence")).SecurityError) throw error;
    if (error instanceof JobRequestError) return Response.json({ error: error.message }, { status: error.status });
    if (error && typeof error === "object" && "code" in error && error.code === "23505") return Response.json({ error: "Conversation already has an active run" }, { status: 409 });
    log("error", "job.submit_failed", { error_code: errorCode(error) });
    return Response.json({ error: "Database unavailable" }, { status: 503 });
  }
}

export async function POST(request: Request) {
 return protectedApi(request,"agent:execute",()=>handlePOST(request));
}
