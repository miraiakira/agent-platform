import { protectedApi } from "@/lib/security";
import { security } from "@/lib/persistence";
import { getAuth } from "@/lib/auth";
import { SecurityError } from "@eap/persistence";
import { eventStore, store } from "@/lib/persistence";
import { validRunId } from "@/lib/async-agent-access";
import { runEventStream } from "@/lib/run-event-stream";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handleGET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!validRunId(id)) return Response.json({ error: "Invalid run ID" }, { status: 400 });
  const cursor = request.headers.get("last-event-id") ?? new URL(request.url).searchParams.get("after") ?? "0";
  if (!/^\d{1,19}$/.test(cursor) || BigInt(cursor) > BigInt("9223372036854775807")) return Response.json({ error: "Invalid event cursor" }, { status: 400 });
  try {
    if (!await store.getRun(id)) return await security.resourceDenied("run",id);
    return new Response(runEventStream({ runId: id, cursor, signal: request.signal, events: eventStore, store, authorize: async () => {
      if (!await (await getAuth()).api.getSession({headers:request.headers,query:{disableCookieCache:true}})) throw new SecurityError(401,"UNAUTHENTICATED");
      await security.authorize("agent:read");
    } }), {
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
    });
  } catch(error) { if(error instanceof (await import("@eap/persistence")).SecurityError) throw error; return Response.json({ error: "Database unavailable" }, { status: 503 }); }
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
 return protectedApi(request,"agent:read",()=>handleGET(request, context));
}
