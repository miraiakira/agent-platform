import { security } from "@/lib/persistence";
import { protectedApi } from "@/lib/security";
import { NextResponse } from "next/server";
import { store } from "@/lib/persistence";

export const runtime = "nodejs";

type Context = {
  params: Promise<{ id: string }>;
};

async function handleGET(
  _request: Request,
  context: Context,
) {
  const { id } = await context.params;

  const conversation =
    await store.getConversation(id);

  if (!conversation) {
    return await security.resourceDenied("conversation",id);
  }

  const runs = await store.listRuns(id);

  return NextResponse.json({ runs });
}
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
 return protectedApi(request,"agent:read",()=>handleGET(request, context));
}
