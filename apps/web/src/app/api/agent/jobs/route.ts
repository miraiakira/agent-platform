import { randomUUID } from "node:crypto";
import { z } from "zod";

import { store, jobQueue } from "@/lib/persistence";

export const runtime = "nodejs";

const schema = z.object({
  conversationId: z.string().uuid(),
  messages: z.array(
    z.object({
      role: z.enum(["user", "assistant"]),
      content: z.string().min(1).max(8000),
    }),
  ).min(1).max(20),
});

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Invalid JSON" },
      { status: 400 },
    );
  }

  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid request" },
      { status: 400 },
    );
  }

  const { conversationId, messages } = parsed.data;

  const conversation =
    await store.getConversation(conversationId);

  if (!conversation) {
    return Response.json(
      { error: "Conversation not found" },
      { status: 404 },
    );
  }

  try {
    const run = await store.createRun({
      conversationId,
      traceId: randomUUID(),
      messages,
    });

    await jobQueue.enqueue({
      runId: run.id,
    });

    return Response.json(
      {
        runId: run.id,
        conversationId,
        status: "queued",
        eventsUrl: `/api/agent/runs/${run.id}/events`,
      },
      { status: 202 },
    );
  } catch (error) {
    console.error("Failed to enqueue agent", error);

    return Response.json(
      { error: "Failed to create job" },
      { status: 500 },
    );
  }
}