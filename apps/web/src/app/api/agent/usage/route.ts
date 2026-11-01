import { protectedApi } from "@/lib/security";
import { store } from "@/lib/persistence";
export const runtime = "nodejs";
async function handleGET() {
  try { return Response.json({ models: await store.usageByModel() }); }
  catch { return Response.json({ error: "Database unavailable" }, { status: 503 }); }
}

export async function GET(request: Request) {
 return protectedApi(request,"agent:read",()=>handleGET());
}
