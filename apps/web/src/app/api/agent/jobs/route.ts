import { z } from "zod";
import { JobRequestError } from "@eap/persistence";
import { jobLifecycle } from "@/lib/persistence";
import { asyncAgentAccess } from "@/lib/async-agent-access";

export const runtime = "nodejs";
const schema = z.object({
  conversationId: z.string().uuid().optional(),
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(8000) }).strict()).min(1).max(20),
}).strict();

export async function POST(request: Request) {
  const denied = asyncAgentAccess(request);
  if (denied) return denied;
  const requestKey = request.headers.get("idempotency-key");
  if (!requestKey || !/^[a-zA-Z0-9_-]{1,128}$/.test(requestKey)) return Response.json({ error: "Valid Idempotency-Key required" }, { status: 400 });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  try {
    const run = await jobLifecycle.submit({ ...parsed.data, requestKey });
    return Response.json({ runId: run.id, conversationId: run.conversation_id, status: run.status,
      eventsUrl: `/api/agent/runs/${run.id}/events` }, { status: 202 });
  } catch (error) {
    if (error instanceof JobRequestError) return Response.json({ error: error.message }, { status: error.status });
    if (error && typeof error === "object" && "code" in error && error.code === "23505") return Response.json({ error: "Conversation already has an active run" }, { status: 409 });
    console.error("Failed to enqueue agent", error);
    return Response.json({ error: "Database unavailable" }, { status: 503 });
  }
}
