import { NextResponse } from "next/server";
import { z } from "zod";

import {
  AIError,
  AIService,
  createModelProvider,
  encodeSSE,
  type StreamEvent,
} from "@eap/ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(8000),
      }),
    )
    .min(1)
    .max(20),
});

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: {
          code: "INVALID_REQUEST",
          message: "Invalid JSON",
        },
      },
      { status: 400 },
    );
  }

  const parsed = requestSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: "INVALID_REQUEST",
          message: "Invalid chat messages",
        },
      },
      { status: 400 },
    );
  }

  const providerName = process.env.LLM_PROVIDER ?? "mock";

  if (
    providerName !== "deepseek" &&
    providerName !== "mock"
  ) {
    return NextResponse.json(
      {
        error: {
          code: "CONFIG_ERROR",
          message: "Unsupported provider",
        },
      },
      { status: 500 },
    );
  }

  let service: AIService;

  try {
    service = new AIService(
      createModelProvider({
        provider: providerName,
        apiKey: process.env.LLM_API_KEY,
        model: process.env.LLM_MODEL,
        baseURL: process.env.LLM_BASE_URL || undefined,
      }),
    );
  } catch {
    return NextResponse.json(
      {
        error: {
          code: "CONFIG_ERROR",
          message: "Model provider configuration failed",
        },
      },
      { status: 500 },
    );
  }

  const configuredTimeout = Number(
    process.env.LLM_TIMEOUT_MS ?? 30000,
  );

  const timeoutMs =
    Number.isFinite(configuredTimeout) &&
    configuredTimeout >= 1000 &&
    configuredTimeout <= 120000
      ? configuredTimeout
      : 30000;

  const encoder = new TextEncoder();
  const controller = new AbortController();

  // 与浏览器连接取消信号关联。
  const abort = () => controller.abort();

  if (request.signal.aborted) {
    controller.abort();
  } else {
    request.signal.addEventListener("abort", abort, {
      once: true,
    });
  }

  const messages = [
    {
      role: "system" as const,
      content: "You are a helpful enterprise AI assistant.",
    },
    ...parsed.data.messages,
  ];

  const stream = new ReadableStream<Uint8Array>({
    async start(streamController) {
      let closed = false;

      const send = (event: StreamEvent) => {
        if (closed || controller.signal.aborted) return;

        try {
          streamController.enqueue(
            encoder.encode(encodeSSE(event)),
          );
        } catch {
          closed = true;
          controller.abort();
        }
      };

      try {
        for await (const event of service.stream({
          messages,
          signal: controller.signal,
          timeoutMs,
        })) {
          if (controller.signal.aborted) break;
          send(event);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          const code =
            error instanceof AIError
              ? error.code
              : "PROVIDER_ERROR";

          send({
            type: "error",
            code,
            message: "Model streaming failed",
          });
        }
      } finally {
        closed = true;
        request.signal.removeEventListener("abort", abort);

        try {
          streamController.close();
        } catch {
          // Stream may already have been cancelled.
        }
      }
    },

    cancel() {
      controller.abort();
      request.signal.removeEventListener("abort", abort);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}