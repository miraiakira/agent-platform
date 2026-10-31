import { store } from "@/lib/persistence";
import { asyncAgentAccess } from "@/lib/async-agent-access";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const denied = asyncAgentAccess(request);
  if (denied) return denied;
  try { return Response.json({ models: await store.usageByModel() }); }
  catch { return Response.json({ error: "Database unavailable" }, { status: 503 }); }
}
