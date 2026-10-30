import { NextResponse } from "next/server";
import { store } from "@/lib/persistence";

export const runtime = "nodejs";

type Context = {
  params: Promise<{ id: string }>;
};

export async function GET(
  _request: Request,
  context: Context,
) {
  const { id } = await context.params;

  const conversation =
    await store.getConversation(id);

  if (!conversation) {
    return NextResponse.json(
      { error: "Conversation not found" },
      { status: 404 },
    );
  }

  const messages = await store.listMessages(id);

  return NextResponse.json({
    conversation,
    messages,
  });
}